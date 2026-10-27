"""Bounded repository rule reads using openat/dir_fd + O_NOFOLLOW at EVERY step.

No imports from repositories, shell, Git execution, recursion or disk writes.
The Node adapter supplies only server-owned contexts; web clients never send paths.
"""
import json
import itertools
import os
import re
import stat
import sys

LIMIT = 256 * 1024
ROOT_NAMES = {'agents.md', 'teams.md', 'team.md', 'claude.md', 'gemini.md'}
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY


class Denied(Exception):
    pass


def identity(st):
    return [str(st.st_dev), str(st.st_ino), str(st.st_size), str(st.st_mtime_ns), str(st.st_ctime_ns)]


def components(rel):
    if not isinstance(rel, str) or not rel or len(rel) > 1024 or '\\' in rel or ':' in rel or re.search(r'[\x00-\x1f\x7f]', rel):
        raise Denied('invalid_path')
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts) or not parts[-1].lower().endswith('.md'):
        raise Denied('invalid_path')
    if any(p.startswith('.') and not (i == 0 and p == '.codex' and len(parts) == 2 and parts[1].lower() == 'agents.md') for i, p in enumerate(parts)):
        raise Denied('invalid_path')
    if any(p.lower() in ('node_modules', 'vendor', 'dist', 'build') for p in parts):
        raise Denied('invalid_path')
    return parts


def open_root(root, expected=None):
    if not os.path.isabs(root) or root in ('/', os.path.expanduser('~')):
        raise Denied('invalid_root')
    fd = os.open('/', FLAGS)
    try:
        for part in root.split('/')[1:]:
            if not part or part in ('.', '..'):
                raise Denied('invalid_root')
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        st = os.fstat(fd)
        if expected and identity(st)[:2] != expected[:2]:
            raise Denied('scope_changed')
        marker = os.stat('.git', dir_fd=fd, follow_symlinks=False)
        if not (stat.S_ISREG(marker.st_mode) or stat.S_ISDIR(marker.st_mode)):
            raise Denied('not_repository')
        return fd
    except Exception:
        os.close(fd)
        raise


def parent_fd(root_fd, parts):
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            try:
                os.stat('.git', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise Denied('nested_repository')
        return fd
    except Exception:
        os.close(fd)
        raise


def inspect(root_fd, rel):
    parts = components(rel)
    fd = parent_fd(root_fd, parts)
    try:
        st = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise Denied('not_regular_file')
        if st.st_size > LIMIT:
            raise Denied('too_large')
        return identity(st)
    finally:
        os.close(fd)


def repo_for(cwd):
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or len(cwd) > 4096:
        raise Denied('invalid_root')
    cwd = os.path.realpath(cwd)
    if not os.path.isdir(cwd):
        raise Denied('invalid_root')
    root = cwd
    for _ in range(32):
        if os.path.lexists(os.path.join(root, '.git')):
            fd = open_root(root)
            os.close(fd)
            return root, cwd
        parent = os.path.dirname(root)
        if parent == root:
            break
        root = parent
    raise Denied('not_repository')


def list_files(request):
    contexts = request.get('directories', []) + request.get('roots', [])
    extras = request.get('extraFiles', [])
    if not isinstance(contexts, list) or not isinstance(extras, list):
        raise Denied('invalid_config')
    roots, warnings, output = {}, [], []
    for cwd in contexts[:32]:
        try:
            root, current = repo_for(cwd)
            roots.setdefault(root, set()).add(os.path.relpath(current, root))
        except (OSError, Denied):
            warnings.append('scope_unavailable')
    if len(roots) > 8 or len(contexts) > 32 or len(extras) > 32:
        warnings.append('limit_reached')
    for index, (root, cwds) in enumerate(list(roots.items())[:8]):
        root_fd = open_root(root)
        try:
            root_identity = identity(os.fstat(root_fd))
            dirs = {''}
            for cwd in cwds:
                if cwd != '.':
                    parts = cwd.split('/')
                    for n in range(1, min(len(parts), 16) + 1):
                        dirs.add('/'.join(parts[:n]))
            candidates = set()
            for rel_dir in sorted(dirs):
                try:
                    fd = parent_fd(root_fd, (rel_dir + '/AGENTS.md').split('/') if rel_dir else ['AGENTS.md'])
                    try:
                        with os.scandir(fd) as scan:
                            names = [entry.name for entry in itertools.islice(scan, 513)]
                        if len(names) > 512:
                            warnings.append('limit_reached')
                        for name in names[:512]:
                            if name.lower() in ROOT_NAMES:
                                candidates.add('/'.join(filter(None, [rel_dir, name])))
                    finally:
                        os.close(fd)
                except (OSError, Denied):
                    warnings.append('partial_scope')
            for folder in ['docs', '.codex']:
                try:
                    fd = parent_fd(root_fd, [folder, 'AGENTS.md'])
                    try:
                        with os.scandir(fd) as scan:
                            names = [entry.name for entry in itertools.islice(scan, 513)]
                        if len(names) > 512:
                            warnings.append('limit_reached')
                        for name in names[:512]:
                            if (folder == '.codex' and name.lower() == 'agents.md') or (folder == 'docs' and re.match(r'^team.*\.md$', name, re.I)):
                                candidates.add(folder + '/' + name)
                    finally:
                        os.close(fd)
                except FileNotFoundError:
                    pass
                except (OSError, Denied):
                    warnings.append('partial_scope')
            for rel in extras[:32]:
                try:
                    components(rel)
                    candidates.add(rel)
                except Denied:
                    warnings.append('invalid_extra_file')
            for rel in sorted(candidates):
                if len(output) >= 128:
                    warnings.append('limit_reached')
                    break
                try:
                    expected = inspect(root_fd, rel)
                    output.append({'root': root, 'rootIdentity': root_identity, 'path': rel, 'identity': expected,
                                   'scope': 'Repository ' + str(index + 1), 'size': int(expected[2])})
                except FileNotFoundError:
                    pass
                except (OSError, Denied):
                    warnings.append('file_unavailable')
        finally:
            os.close(root_fd)
    return {'files': output, 'warnings': sorted(set(warnings)), 'scopeCount': min(len(roots), 8)}


def read_file(request):
    root_fd = open_root(request['root'], request['rootIdentity'])
    fd = parent = None
    try:
        parts = components(request['path'])
        parent = parent_fd(root_fd, parts)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Denied('not_regular_file')
        if identity(before) != request['identity']:
            raise Denied('file_changed')
        chunks, size = [], 0
        while size <= LIMIT:
            chunk = os.read(fd, min(65536, LIMIT + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        if size > LIMIT:
            raise Denied('too_large')
        if identity(os.fstat(fd)) != identity(before):
            raise Denied('file_changed')
        raw = b''.join(chunks)
        if b'\0' in raw:
            raise Denied('not_utf8')
        try:
            content = raw.decode('utf-8-sig', errors='strict')
        except UnicodeDecodeError:
            raise Denied('not_utf8')
        return {'content': content}
    finally:
        for handle in [fd, parent, root_fd]:
            if handle is not None:
                os.close(handle)


def main():
    try:
        if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
            raise Denied('unsupported_platform')
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise Denied('request_limit')
        request = json.loads(raw)
        result = list_files(request) if request['mode'] == 'list' else read_file(request) if request['mode'] == 'read' else None
        if result is None:
            raise Denied('invalid_request')
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except Denied as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'unavailable'}))


if __name__ == '__main__':
    main()
