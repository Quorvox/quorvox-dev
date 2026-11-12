import qrcode from 'qrcode-generator';

// QR-код адреса в виде SVG. Строим в самом расширении, в окно уходит готовая картинка.
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
