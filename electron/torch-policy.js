// One deterministic PyTorch baseline for every installation path.
//
// CUDA 12.8 is the compatibility floor for current NVIDIA hardware and runs
// on drivers >= 525. Newer drivers remain backwards-compatible, so using the
// explicit cu128 index everywhere avoids PyPI's CPU-only Windows wheels and
// keeps Windows/Linux on the same tested package triplet.
const CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
const CUDA_INDEX = 'https://download.pytorch.org/whl/cu128';

function flavorForDriver(driverText) {
  if (driverText == null || String(driverText).trim() === '') {
    return {
      mode: 'cpu',
      index: CPU_INDEX,
      reason: 'no NVIDIA driver found — CPU processing',
    };
  }

  const raw = String(driverText).trim();
  const major = parseInt(raw, 10);
  if (Number.isFinite(major) && major >= 525) {
    return {
      mode: 'cuda',
      index: CUDA_INDEX,
      reason: `NVIDIA driver ${raw}: CUDA (cu128 wheels)`,
    };
  }

  return {
    mode: 'cpu',
    index: CPU_INDEX,
    reason:
      `NVIDIA driver ${raw || '(unreadable)'} too old for current torch — ` +
      'CPU processing',
  };
}

module.exports = { CPU_INDEX, CUDA_INDEX, flavorForDriver };
