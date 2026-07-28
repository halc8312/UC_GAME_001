import { chromium } from '@playwright/test';

const FLAG_SETS = {
  'baseline': [],
  'swiftshader': ['--enable-unsafe-swiftshader'],
  'angle-swiftshader': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  'gl-egl': ['--use-gl=egl'],
};

for (const [name, args] of Object.entries(FLAG_SETS)) {
  let browser;
  try {
    browser = await chromium.launch({ args });
    const page = await browser.newPage();
    await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
    const info = await page.evaluate(() => {
      const c = document.getElementById('c');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, reason: 'no context' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    });
    console.log(name, JSON.stringify(info));
  } catch (e) {
    console.log(name, 'LAUNCH FAIL', e.message.split('\n')[0]);
  } finally {
    await browser?.close();
  }
}
