import jsQR, { type QRCode, type Options } from "jsqr";
// jsQR ships CommonJS runtime plus an ES default declaration; NodeNext sees a namespace.
const readQR = jsQR as unknown as (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: Options,
) => QRCode | null;
export function decode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width < 1 || height < 1 || pixels.length !== width * height * 4)
    return null;
  return (
    readQR(pixels, width, height, { inversionAttempts: "attemptBoth" })?.data ||
    null
  );
}
