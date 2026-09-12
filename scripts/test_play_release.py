import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import play_release as release

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.manifest = dict(tag='android-v0.2.9-preview.1', packageName=release.PACKAGE,
            versionCode=12, aab='Boxie-Android-0.2.9.aab', sha256=hashlib.sha256(b'bundle').hexdigest(),
            releaseName='0.2.9', releaseNotes=[dict(language='en-US', text='Archive conversations.')])
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dest = Path(self.tmp.name)
        (self.dest / self.manifest['aab']).write_bytes(b'bundle')

    def test_reject_invalid_metadata(self):
        for field, value in [('versionCode', True), ('packageName', 'other.app'),
                             ('aab', 'Boxie-Android-0.2.8.aab'), ('sha256', 'bad'),
                             ('releaseNotes', [dict(language='en-US', text='x'*501)])]:
            manifest = copy.deepcopy(self.manifest)
            manifest[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.validate(manifest, manifest['tag'])

    def test_validate_never_uploads_or_commits(self):
        with patch.object(release, 'request', side_effect=[{'id':'1'}, {}, {}, {}]) as req:
            self.assertEqual(release.publish(self.manifest, self.dest, 'validate')['status'], 'validated')
            self.assertEqual([c.args[0] for c in req.call_args_list], ['POST','GET','GET','DELETE'])

    def test_reject_newer_track_and_cleanup(self):
        with patch.object(release, 'request', side_effect=[{'id':'1'}, {'releases':[{'versionCodes':['13']}]}, {}, {}]) as req:
            with self.assertRaises(ValueError):
                release.publish(self.manifest, self.dest, 'publish')
            self.assertEqual(req.call_args_list[-1].args, ('DELETE','/edits/1'))

    def test_wrong_uploaded_bundle_never_commits(self):
        with patch.object(release, 'request', side_effect=[{'id':'1'}, {}, {}, {'versionCode':13,'sha256':self.manifest['sha256']}, {}]) as req:
            with self.assertRaises(ValueError):
                release.publish(self.manifest, self.dest, 'publish')
            self.assertFalse(any(':commit' in c.args[1] for c in req.call_args_list))

    def test_publish_verifies_notes(self):
        bundle = dict(versionCode=12, sha256=self.manifest['sha256'])
        track = {'releases':[dict(versionCodes=['12'], status='completed', releaseNotes=self.manifest['releaseNotes'])]}
        with patch.object(release, 'request', side_effect=[{'id':'1'}, {}, {}, bundle, {}, {}, {}, {'id':'2'}, track, {}]) as req:
            self.assertEqual(release.publish(self.manifest, self.dest, 'publish')['status'], 'published')
            body = next(c.args[2] for c in req.call_args_list if c.args[0] == 'PUT')
            self.assertEqual(body['releases'][0]['releaseNotes'], self.manifest['releaseNotes'])

    def test_uncertain_commit_is_not_retried(self):
        bundle = dict(versionCode=12, sha256=self.manifest['sha256'])
        with patch.object(release, 'request', side_effect=[{'id':'1'}, {}, {}, bundle, {}, {}, TimeoutError(), {}]) as req:
            with self.assertRaises(TimeoutError):
                release.publish(self.manifest, self.dest, 'publish')
            self.assertEqual(sum(':commit' in c.args[1] for c in req.call_args_list), 1)

    def test_existing_identical_release_is_noop(self):
        bundle = dict(versionCode=12, sha256=self.manifest['sha256'])
        track = {'releases':[dict(versionCodes=['12'], status='completed', name=self.manifest['releaseName'], releaseNotes=self.manifest['releaseNotes'])]}
        with patch.object(release, 'request', side_effect=[{'id':'1'}, track, {'bundles':[bundle]}, {}]) as req:
            self.assertEqual(release.publish(self.manifest, self.dest, 'publish')['status'], 'already_published')
            self.assertFalse(any(c.args[0] == 'PUT' for c in req.call_args_list))

if __name__ == '__main__':
    unittest.main()
