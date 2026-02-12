const { test, expect } = require('@playwright/test');

test('abre example', async ({ page }) => {
  await page.goto('https://prod.gestorjuridico.com.br/Paginas/Principal/_FSet_Abertura.asp');
  await expect(page).toHaveTitle(/Example/);
});