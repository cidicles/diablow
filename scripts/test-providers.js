// No-network checks of the provider layer: response parsing, file refs, job
// id routing and cost tables. Nothing here spends a credit.
process.env.FAL_KEY = 'test-key-not-used';
process.env.APIFRAME_API_KEY = 'test-key-not-used';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createProvider, PROVIDER_INFO, PROVIDER_NAMES } = require('./lib/providers');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const ROOT = path.join(__dirname, '..');
const fal = createProvider('fal', ROOT);
const af = createProvider('apiframe', ROOT);

console.log('\nfal: response parsing');
eq('extractImages maps {url} objects',
  fal.extractImages({ images: [{ url: 'https://a/1.png' }, { url: 'https://a/2.png' }] }),
  ['https://a/1.png', 'https://a/2.png']);
eq('extractImages passes plain strings', fal.extractImages({ images: ['https://a/1.png'] }), ['https://a/1.png']);
eq('extractImages returns null when absent', fal.extractImages({ seed: 1 }), null);
eq('extractVideo reads video.url', fal.extractVideo({ video: { url: 'https://a/v.mp4' } }), 'https://a/v.mp4');
eq('extractVideo returns null when absent', fal.extractVideo({}), null);
eq('extractJobId reads the composed id', fal.extractJobId({ jobId: 'fal-ai/flux/schnell:abc' }), 'fal-ai/flux/schnell:abc');

console.log('\napiframe: response parsing unchanged');
eq('extractImages reads image_urls', af.extractImages({ result: { image_urls: ['https://a/1.png'] } }), ['https://a/1.png']);
eq('extractVideo reads videoUrl', af.extractVideo({ result: { videoUrl: 'https://a/v.mp4' } }), 'https://a/v.mp4');
eq('extractJobId reads task_id', af.extractJobId({ task_id: 'xyz' }), 'xyz');

console.log('\nfal: local file refs become data URIs');
const tmp = path.join(os.tmpdir(), 'provider-test.png');
fs.writeFileSync(tmp, Buffer.from('89504e470d0a1a0a', 'hex'));
(async () => {
  const ref = await fal.ref(tmp);
  ok('ref() returns a png data URI', ref.startsWith('data:image/png;base64,'), ref.slice(0, 40));
  eq('ref() round-trips the bytes',
    Buffer.from(ref.split(',')[1], 'base64').toString('hex'),
    '89504e470d0a1a0a');

  console.log('\nfal: job id routing');
  let threw = null;
  try { await fal.waitForJob('plain-apiframe-id'); } catch (e) { threw = e.message; }
  ok('waitForJob rejects a non-fal job id', /Not a fal job id/.test(threw || ''), threw);

  console.log('\ncost tables');
  eq('providers registered', PROVIDER_NAMES, ['apiframe', 'fal']);
  eq('apiframe kling 5s is 22 cr', PROVIDER_INFO.apiframe.videoModels['kling-2.5-turbo-pro'].credits(5), 22);
  eq('apiframe kling 10s is 44 cr', PROVIDER_INFO.apiframe.videoModels['kling-2.5-turbo-pro'].credits(10), 44);
  eq('fal kling 5s is 35 cr ($0.35)', PROVIDER_INFO.fal.videoModels['kling-2.5-turbo-pro'].credits(5), 35);
  eq('fal kling 10s is 70 cr ($0.70)', PROVIDER_INFO.fal.videoModels['kling-2.5-turbo-pro'].credits(10), 70);
  eq('fal bg-remove is 2 cr', PROVIDER_INFO.fal.backgroundRemoveCredits, 2);
  ok('fal keyframe model is Apache-2.0',
    /Apache-2\.0/.test(PROVIDER_INFO.fal.keyframeModels['flux-schnell'].licence));
  ok('apiframe keyframe is flagged as unsafe to resell',
    /NOT safe to resell/.test(PROVIDER_INFO.apiframe.keyframeModels.midjourney.licence));
  ok('flux-dev is absent (non-commercial licence)',
    !Object.keys(PROVIDER_INFO.fal.keyframeModels).some(k => /dev/.test(k)));

  console.log('\nfal: video params keep the end-frame pin');
  const p = PROVIDER_INFO.fal.videoModels['kling-2.5-turbo-pro'].params({ start: 'S', end: 'E', duration: 5 });
  eq('start goes to image_url', p.image_url, 'S');
  eq('end goes to tail_image_url', p.tail_image_url, 'E');
  eq('duration is a string', p.duration, '5');
  const unpinned = PROVIDER_INFO.fal.videoModels['kling-2.5-turbo-pro'].params({ start: 'S', end: null, duration: 10 });
  ok('no tail_image_url when unpinned', !('tail_image_url' in unpinned));
  eq('10s duration is a string', unpinned.duration, '10');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
