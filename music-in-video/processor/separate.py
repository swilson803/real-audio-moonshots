# Music/speech separation for the processor (MS-007): Demucs v4 htdemucs,
# exactly as in the separation experiment (arm C, kept), on CPU.
#   stdin   the uploaded soundtrack's samples: 16 kHz mono int16 little-endian
#   stdout  the music stem (drums + bass + other: everything but "vocals"),
#           same format and rate
#   stderr  last line: {"cpu_ms", "peak_mb"} of this process (cost reporting)
# Threads: SEPARATION_THREADS (default 4: the standard-4 instance's vCPUs).
# apply_model shifts the input by a random 0-0.5 s (Demucs' "shift trick");
# the generator is seeded so the same upload always gives the same stem.
import json
import os
import random
import resource
import sys

import numpy as np
import torch
import torchaudio.functional as AF
from demucs.apply import apply_model
from demucs.pretrained import get_model

torch.set_num_threads(int(os.environ.get('SEPARATION_THREADS', '4')))
random.seed(0)
model = get_model('htdemucs')
model.eval()
x = np.frombuffer(sys.stdin.buffer.read(), dtype='<i2').astype(np.float32) / 32768
wav = AF.resample(torch.from_numpy(x)[None], 16000, model.samplerate).repeat(2, 1)
ref = wav.mean(0)
mean, std = ref.mean(), ref.std() + 1e-8
with torch.no_grad():
    out = apply_model(model, ((wav - mean) / std)[None], device='cpu', split=True, overlap=0.25, progress=False)[0]
out = out * std + mean
music = sum(out[i] for i, s in enumerate(model.sources) if s != 'vocals').mean(0)
m16 = AF.resample(music[None], model.samplerate, 16000)[0].numpy()
sys.stdout.buffer.write(np.clip(np.round(m16 * 32767), -32768, 32767).astype('<i2').tobytes())
ru = resource.getrusage(resource.RUSAGE_SELF)
print(json.dumps({'cpu_ms': round((ru.ru_utime + ru.ru_stime) * 1000), 'peak_mb': round(ru.ru_maxrss / 1024)}), file=sys.stderr)
