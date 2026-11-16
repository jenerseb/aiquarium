// AIquarium · Cozy-Diorama-Konstanten (eigenes Modul: kein Shadowing, keine TDZ).
// Wird von public/scene.js als ERSTES importiert — vor allem anderen.
export const TEXTUR_FAKTOR = 4;
// Warme Hamburger Fassadenpalette (Backsteinrot, Creme, Sandstein, Altbau-Grau)
export const DIORAMA_FASSADEN = ['#b3563f', '#c97e5a', '#e3c893', '#d9b98a', '#9aa0a8', '#8f4f43', '#c4a484', '#a85840'];
// Daecher (Terrakotta, Schiefergrau, Kupfergruen)
export const DIORAMA_DAECHER = ['#9c4a3b', '#a85638', '#343942', '#4a4f57', '#4e786c'];
export function dioramaFarbe(id, palette) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
