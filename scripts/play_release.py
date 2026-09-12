"""Publish an existing, checksummed GitHub release to Boxie's internal Play track."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

PACKAGE = 'ai.dionlabs.boxie'
REPO = 'dion-labs/boxie'
API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE

def validate(manifest, tag):
    if not re.fullmatch(r'android-v\d+\.\d+\.\d+-preview\.\d+', tag):
        raise ValueError('Expected an Android preview release tag')
    if manifest['tag'] != tag or manifest['packageName'] != PACKAGE:
        raise ValueError('Release identity mismatch')
    if type(manifest['versionCode']) is not int or manifest['versionCode'] <= 0:
        raise ValueError('Invalid version code')
    if not re.fullmatch(r'Boxie-Android-\d+\.\d+\.\d+\.aab', manifest['aab']):
        raise ValueError('Invalid AAB asset name')
    if manifest['aab'] != 'Boxie-Android-' + tag.split('-')[1][1:] + '.aab':
        raise ValueError('AAB version does not match tag')
    if not re.fullmatch('[a-f0-9]{64}', manifest['sha256']):
        raise ValueError('Invalid checksum')
    if not 1 <= len(manifest['releaseName']) <= 50:
        raise ValueError('Release name must be 1–50 characters')
    notes = manifest['releaseNotes']
    if not notes or len({n['language'] for n in notes}) != len(notes):
        raise ValueError('Missing or duplicate release-note languages')
    for note in notes:
        if not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]+)*', note['language']) or not 1 <= len(note['text']) <= 500:
            raise ValueError('Each localized release note must contain 1–500 characters')
    return manifest

def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)

def prepare(tag, destination):
    if not re.fullmatch(r'android-v\d+\.\d+\.\d+-preview\.\d+', tag):
        raise ValueError('Expected an Android preview release tag')
    destination.mkdir(parents=True, exist_ok=True)
    release = json.loads(gh('release', 'view', tag, '-R', REPO, '--json', 'tagName,isDraft,assets,url'))
    if release['isDraft'] or release['tagName'] != tag:
        raise ValueError('Expected a published release')
    gh('release', 'download', tag, '-R', REPO, '-p', 'play-release.json', '-D', str(destination))
    manifest = validate(json.loads((destination / 'play-release.json').read_text()), tag)
    if len([a for a in release['assets'] if a['name'] == manifest['aab']]) != 1:
        raise ValueError('Expected exactly one matching AAB')
    gh('release', 'download', tag, '-R', REPO, '-p', manifest['aab'], '-D', str(destination))
    if hashlib.sha256((destination / manifest['aab']).read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('AAB checksum mismatch')
    return manifest

def request(method, path, payload=None, binary=False):
    token = os.environ['PLAY_ACCESS_TOKEN']
    url = ('https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/' + PACKAGE if binary else API) + path
    data = payload if binary else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream' if binary else 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as response:
        body = response.read()
        return json.loads(body) if body else {}

def cleanup(path):
    try:
        request('DELETE', path)
    except Exception as exc:
        print('Warning: temporary edit cleanup failed: ' + type(exc).__name__, file=sys.stderr)

def publish(manifest, destination, mode):
    if mode not in ('validate', 'publish'):
        raise ValueError('Invalid publication mode')
    # Each run owns its edit. Never retry an uncertain commit automatically.
    edit = request('POST', '/edits', {})['id']
    path = '/edits/' + edit
    committed = False
    try:
        current = request('GET', path + '/tracks/internal')
        bundles = request('GET', path + '/bundles').get('bundles', [])
        code = str(manifest['versionCode'])
        desired = {'name': manifest['releaseName'], 'versionCodes': [code],
                   'releaseNotes': manifest['releaseNotes'], 'status': 'completed', 'inAppUpdatePriority': 0}
        existing = next((b for b in bundles if str(b['versionCode']) == code), None)
        if existing and existing.get('sha256') != manifest['sha256']:
            raise ValueError('Version code already exists with a different bundle')
        if any(int(v) > int(code) for r in current.get('releases', []) for v in r.get('versionCodes', [])):
            raise ValueError('Refusing to replace a newer internal release')
        if mode == 'validate':
            return {'status': 'validated', 'track': 'internal', 'versionCode': code,
                    'note': 'Artifacts and Play access verified; nothing uploaded or rolled out.'}
        if existing and any(r.get('versionCodes') == [code] and r.get('status') == 'completed'
                            and r.get('releaseNotes') == manifest['releaseNotes']
                            and r.get('name') == manifest['releaseName'] for r in current.get('releases', [])):
            return {'status': 'already_published', 'track': 'internal', 'versionCode': code}
        if not existing:
            uploaded = request('POST', path + '/bundles?uploadType=media',
                               (destination / manifest['aab']).read_bytes(), binary=True)
            if str(uploaded['versionCode']) != code or uploaded.get('sha256') != manifest['sha256']:
                raise ValueError('Uploaded bundle identity does not match the manifest')
        request('PUT', path + '/tracks/internal', {'track': 'internal', 'releases': [desired]})
        request('POST', path + ':validate')
        request('POST', path + ':commit')
        committed = True
    finally:
        if not committed:
            cleanup(path)
    verification = request('POST', '/edits', {})['id']
    try:
        track = request('GET', '/edits/' + verification + '/tracks/internal')
        if not any(code in r.get('versionCodes', []) and r.get('status') == 'completed'
                   and r.get('releaseNotes') == manifest['releaseNotes'] for r in track.get('releases', [])):
            raise RuntimeError('Commit returned, but track verification failed; inspect Play before retrying')
        return {'status': 'published', 'track': 'internal', 'versionCode': code, 'releaseName': manifest['releaseName']}
    finally:
        cleanup('/edits/' + verification)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['prepare', 'validate', 'publish'])
    parser.add_argument('--tag', required=True)
    parser.add_argument('--directory', default='play-artifacts')
    args = parser.parse_args()
    directory = Path(args.directory)
    if args.stage == 'prepare':
        result = prepare(args.tag, directory)
    else:
        manifest = validate(json.loads((directory / 'play-release.json').read_text()), args.tag)
        if hashlib.sha256((directory / manifest['aab']).read_bytes()).hexdigest() != manifest['sha256']:
            raise ValueError('AAB checksum mismatch')
        result = publish(manifest, directory, args.stage)
    if args.stage == 'prepare':
        result = {'status': 'prepared', 'release': result, 'changelog': 'https://github.com/' + REPO + '/releases/tag/' + args.tag}
    (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
