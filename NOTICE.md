# Provenance

This library is a JavaScript/WebUSB port of the reverse-engineered M2-Nano
protocol implemented in [K40 Whisperer](https://www.scorchworks.com/K40whisperer/k40whisperer.html)
(GPLv2-or-later), specifically:

- `nano_library.py` — USB transport, packet framing, CRC, handshake protocol
  → ported into `src/crc.js` and `src/transport.js`
- `egv.py` — the LHYMICRO-GL command language and job encoding
  → ported into `src/lhymicro.js`
- `LaserSpeed.py` — feed-rate/gearing encoding, itself originally a
  standalone MIT-licensed module by Tatarize, embedded unmodified (in
  license terms) into K40 Whisperer
  → ported into `src/laser-speed.js`

Because this is a derivative work of GPL-licensed code, this repository is
licensed GPL-3.0-or-later (see `LICENSE`) to stay compatible with the
upstream project, even though the `LaserSpeed.py` portion traces back to an
MIT-licensed original.

No code from K40 Whisperer is vendored here — every file is a from-scratch
JavaScript reimplementation of the same algorithms, written against this
repository's own understanding of the protocol.
