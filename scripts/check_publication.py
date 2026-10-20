"""Check the files Git would publish. Reports paths/rule names, never secret values.

This is a lightweight publication guard, not a substitute for Gitleaks or review.
Requires Python 3 and Git. It works before or after the first commit.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    cwd=ROOT,
).decode().split('\0')
paths = sorted(set(p for p in paths if p))
rules = {
    'OpenAI credential': r'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}',
    'Google credential': r'AIza[0-9A-Za-z_-]{30,}',
    'GitHub credential': r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})',
    'JWT': r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}',
    'credential-bearing connection URL': r'(?:redis|rediss|postgres|postgresql)://[^/\s\'"]+:[^/\s\'"]+@',
    'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'retired hosted endpoint': r'[\w.-]+\.(?:railway\.app|railway\.internal|runpod\.net|supabase\.co|vercel\.app)',
    'personal filesystem path': r'/(?:Users|home)/[^/\s]+/',
}
forbidden_suffixes = {
    '.safetensors', '.pt', '.pth', '.onnx', '.ipynb', '.mov', '.mp4',
    '.sqlite', '.db', '.dump', '.rdb', '.npz', '.npy', '.csv', '.parquet',
    '.pyc', '.pem', '.key', '.p12', '.pfx', '.zip',
}
failures = []
for name in paths:
    path = ROOT / name
    if path.is_symlink():
        failures.append((name, 'symlink is not allowed in publication snapshot'))
        continue
    if not path.is_file():
        failures.append((name, 'missing file'))
        continue
    if (
        path.suffix.lower() in forbidden_suffixes or
        (path.name.startswith('.env') and path.name != '.env.example') or
        path.name in {'PUBLISHING_PLAN.md', '.DS_Store'} or
        set(path.relative_to(ROOT).parts) & {'node_modules', '.runtime', '__pycache__'}
    ):
        failures.append((name, 'excluded file type'))
    if path.stat().st_size > 5 * 1024 * 1024:
        failures.append((name, 'unexpected file larger than 5 MiB'))
    try:
        text = path.read_text()
    except UnicodeError:
        continue
    for rule, pattern in rules.items():
        if re.search(pattern, text):
            failures.append((name, rule))
    if path.suffix == '.md':
        for link in re.findall(r'\]\(([^)]+)\)', text):
            if link.startswith(('https://', 'http://', '#', 'mailto:')):
                continue
            dest = link.split('#', 1)[0]
            if dest and not (path.parent / dest).exists():
                failures.append((name, 'broken documentation link: ' + dest))

for name, rule in failures:
    print(f'{name}: {rule}')
print(f'Checked {len(paths)} publication files; {len(failures)} findings.')
sys.exit(bool(failures))
