/**
 * Renderer-string parsing.
 *
 * The label shown on the menu and in the F3 overlay is derived from
 * `UNMASKED_RENDERER_WEBGL`, and the strings that matter come from hardware this
 * container does not have. They are pinned here as literals — copied from real
 * Chromium, Firefox and Safari reports — because the only run this repository can
 * actually perform returns SwiftShader, and a label that reads
 * "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Devic" tells a player nothing.
 */
import { describe, it, expect } from 'vitest';
import { shortRendererName } from '../../src/engine/renderer.js';

describe('shortRendererName', () => {
  const cases = [
    // Chromium / ANGLE on Windows — the common desktop case.
    [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'NVIDIA GeForce RTX 4070',
    ],
    [
      'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'AMD Radeon RX 6800 XT',
    ],
    [
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Intel(R) UHD Graphics 630',
    ],
    // Chromium / ANGLE on Linux, Vulkan backend: the adapter is nested one deeper.
    [
      'ANGLE (NVIDIA, Vulkan 1.3.242 (NVIDIA GeForce RTX 3060 (0x00002504)), NVIDIA)',
      'NVIDIA GeForce RTX 3060',
    ],
    // Apple Silicon.
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      'ANGLE Metal Renderer: Apple M2 Pro'],
    // Headless CI — the only one this repository can produce for itself.
    [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'SwiftShader Device (Subzero)',
    ],
    // Mesa software fallback, reported without an ANGLE wrapper.
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'llvmpipe (LLVM 15.0.7, 256 bits)'],
    // Firefox and Safari report the adapter directly.
    ['Apple M1', 'Apple M1'],
    ['AMD Radeon Pro 5500M OpenGL Engine', 'AMD Radeon Pro 5500M'],
  ];

  for (const [raw, expected] of cases) {
    it(`reduces ${raw.slice(0, 44)}…`, () => {
      expect(shortRendererName(raw)).toBe(expected);
    });
  }

  it('never returns an empty label', () => {
    for (const input of ['', null, undefined, '   ']) {
      expect(shortRendererName(input)).toBe('unknown');
    }
  });

  it('caps the label so it cannot overflow the overlay', () => {
    const long = `ANGLE (Vendor, ${'X'.repeat(400)}, D3D11)`;
    expect(shortRendererName(long).length).toBeLessThanOrEqual(46);
  });

  it('leaves an unrecognised string usable rather than blanking it', () => {
    expect(shortRendererName('Mali-G78 MP14')).toBe('Mali-G78 MP14');
  });
});
