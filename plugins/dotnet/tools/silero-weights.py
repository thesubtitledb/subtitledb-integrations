"""Writes the Silero VAD v5 16 kHz weights for SubtitleDb.Core/Sync/Silero.cs.

The plugin runs the network in C#, so it needs the numbers and not the ONNX
graph. This takes them out of the graph, runs the same network in numpy against
onnxruntime to prove the order and the layout, and writes them as little-endian
float32 after the magic SLR5. With --golden it also writes onnxruntime's
probabilities for a 16 kHz s16le file, which the C# test holds to.

  python3 tools/silero-weights.py silero_vad.onnx out.bin [--golden in.pcm out.txt]

Needs numpy, onnx and onnxruntime. The model is MIT, (c) Silero Team:
https://github.com/snakers4/silero-vad
"""

import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

ORDER = [
    "stft.forward_basis_buffer",
    "encoder.0.reparam_conv.weight",
    "encoder.0.reparam_conv.bias",
    "encoder.1.reparam_conv.weight",
    "encoder.1.reparam_conv.bias",
    "encoder.2.reparam_conv.weight",
    "encoder.2.reparam_conv.bias",
    "encoder.3.reparam_conv.weight",
    "encoder.3.reparam_conv.bias",
    "decoder.rnn.weight_ih",
    "decoder.rnn.weight_hh",
    "decoder.rnn.bias_ih",
    "decoder.rnn.bias_hh",
    "decoder.decoder.2.weight",
    "decoder.decoder.2.bias",
]
PREFIX = "If_0_then_branch__Inline_0__"


def weights(path):
    # The 16 kHz network is the then-branch of the graph's first If.
    m = onnx.load(path)
    node = next(n for n in m.graph.node if n.op_type == "If")
    branch = next(a.g for a in node.attribute if a.name == "then_branch")
    found = {}

    def walk(g):
        for n in g.node:
            for a in n.attribute:
                if n.op_type == "Constant" and a.type == onnx.AttributeProto.TENSOR:
                    found[n.output[0].removeprefix(PREFIX)] = numpy_helper.to_array(a.t)
                if a.type == onnx.AttributeProto.GRAPH:
                    walk(a.g)

    walk(branch)
    missing = [k for k in ORDER if k not in found]
    if missing:
        sys.exit(f"not a Silero v5 graph, missing {missing}")
    return [found[k].astype("<f4") for k in ORDER]


def sig(z):
    return 1 / (1 + np.exp(-z))


def conv(x, w, b, stride):
    xp = np.pad(x, ((0, 0), (1, 1)))
    t = (x.shape[1] - 1) // stride + 1
    out = np.stack(
        [np.einsum("oik,ik->o", w, xp[:, i * stride : i * stride + 3]) for i in range(t)], 1
    )
    return np.maximum(out + b[:, None], 0)


def step(w, x, h, c):
    x = np.concatenate([x, x[-2:-66:-1]])
    s = w[0][:, 0, :] @ np.stack([x[i * 128 : i * 128 + 256] for i in range(4)], 1)
    y = np.sqrt(s[:129] ** 2 + s[129:] ** 2)
    for i, stride in zip(range(1, 9, 2), (1, 2, 2, 1)):
        y = conv(y, w[i], w[i + 1], stride)
    g = w[9] @ y[:, 0] + w[11] + w[10] @ h + w[12]
    c = sig(g[128:256]) * c + sig(g[:128]) * np.tanh(g[256:384])
    h = sig(g[384:]) * np.tanh(c)
    return sig(np.maximum(h, 0) @ w[13][0, :, 0] + w[14]), h, c


def main():
    args = sys.argv[1:]
    w = weights(args[0])
    with open(args[1], "wb") as f:
        f.write(b"SLR5")
        for a in w:
            f.write(a.tobytes())
    if "--golden" not in args:
        return
    pcm_path, out_path = args[args.index("--golden") + 1 :][:2]
    pcm = np.fromfile(pcm_path, "<i2").astype(np.float32) / 32768
    sess = ort.InferenceSession(args[0])
    state = np.zeros((2, 1, 128), np.float32)
    h = np.zeros(128, np.float32)
    c = np.zeros(128, np.float32)
    ctx = np.zeros(64, np.float32)
    ref, ours = [], []
    for k in range(len(pcm) // 512):
        x = np.concatenate([ctx, pcm[k * 512 : (k + 1) * 512]])
        o, state = sess.run(
            None, {"input": x[None], "state": state, "sr": np.array(16000, np.int64)}
        )
        ref.append(float(o.reshape(-1)[0]))
        p, h, c = step(w, x, h, c)
        ours.append(float(np.reshape(p, -1)[0]))
        ctx = x[-64:]
    diff = float(np.abs(np.array(ref) - np.array(ours)).max())
    print(f"{len(ref)} chunks, numpy vs onnxruntime max diff {diff:.2e}")
    if diff > 1e-4:
        sys.exit("the numpy network does not match onnxruntime")
    np.savetxt(out_path, np.array(ref), fmt="%.7f")


if __name__ == "__main__":
    main()
