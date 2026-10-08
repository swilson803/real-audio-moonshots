// Manifest kinds from the file name. The phase-2 manifest (made before this
// fix) gave dev and sweep videos kind "quiet"; the name is authoritative:
//   RA_TEST_quiet_*      quiet  (ACCEPTANCE: run once, never tuned on)
//   RA_TEST_dev_quiet_*  dev    (tuning)
//   RA_TEST_sweep_*      sweep  (tuning / diagnostics)
export function kindOf(video) {
  if (/^RA_TEST_dev_quiet_/.test(video.file)) return 'dev';
  if (/^RA_TEST_sweep_/.test(video.file)) return 'sweep';
  if (/^RA_TEST_quiet_/.test(video.file)) return 'quiet';
  return video.kind;
}

export const withKinds = (videos) => videos.map((v) => ({ ...v, kind: kindOf(v) }));
