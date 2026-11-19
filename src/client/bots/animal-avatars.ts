/** Original animal portraits use one centered, scalable face grid. */
const eyes =
  '<g fill="var(--bot-animal-ink)"><circle cx="36" cy="52" r="4"/><circle cx="64" cy="52" r="4"/></g><g fill="var(--bot-animal-face)"><circle cx="37" cy="51" r="1.3"/><circle cx="65" cy="51" r="1.3"/></g>';
const smile =
  '<path d="M44 69q6 6 12 0" fill="none" stroke="var(--bot-animal-ink)" stroke-width="2.5" stroke-linecap="round"/>';
const cheeks =
  '<g fill="var(--bot-animal-blush)" opacity=".55"><ellipse cx="27" cy="64" rx="6" ry="3"/><ellipse cx="73" cy="64" rx="6" ry="3"/></g>';
const faces: Record<string, string> = {
  cat:
    '<path d="M20 46 18 17q16 2 25 16h14q9-14 25-16l-2 29" fill="var(--bot-animal-fur)"/><path d="m24 35-1-10 12 8m30 0 12-8-1 10" fill="var(--bot-animal-blush)"/><ellipse cx="50" cy="56" rx="35" ry="31" fill="var(--bot-animal-fur)"/><path d="m42 35 8 10 8-10" fill="none" stroke="var(--bot-animal-ink)" stroke-width="4" stroke-linecap="round"/>' +
    eyes +
    '<path d="m46 63 4 4 4-4" fill="var(--bot-animal-blush)"/><path d="m27 66-12-2m12 8-12 2m58-8 12-2m-12 8 12 2" stroke="var(--bot-animal-ink)" stroke-width="2" stroke-linecap="round"/>' +
    smile,
  dog:
    '<path d="M27 26Q5 25 12 67q5 17 20 3m41-44q22-1 15 41-5 17-20 3" fill="var(--bot-animal-shade)"/><ellipse cx="50" cy="51" rx="32" ry="35" fill="var(--bot-animal-fur)"/><path d="M48 18Q26 18 23 48q15 11 25-2" fill="var(--bot-animal-shade)"/>' +
    eyes +
    '<ellipse cx="50" cy="68" rx="19" ry="15" fill="var(--bot-animal-face)"/><path d="M43 61q7-5 14 0l-7 8Z" fill="var(--bot-animal-ink)"/>' +
    smile +
    '<path d="M46 73h8v6q-4 7-8 0Z" fill="var(--bot-animal-blush)"/>',
  fox:
    '<path d="M19 47 17 12l28 21h10l28-21-2 35Z" fill="var(--bot-animal-fur)"/><path d="m23 30-1-9 13 10m30 0 13-10-1 9" fill="var(--bot-animal-ink)"/><path d="M15 43q35-29 70 0l-8 27-27 20-27-20Z" fill="var(--bot-animal-fur)"/><path d="M16 51q17 0 34 23 17-23 34-23L72 76 50 90 28 76Z" fill="var(--bot-animal-face)"/>' +
    eyes +
    '<path d="m44 73 6-3 6 3-6 7Z" fill="var(--bot-animal-ink)"/>' +
    cheeks,
  owl: '<path d="m19 35 1-23 23 14h14l23-14 1 23q16 40-10 51H29Q3 75 19 35" fill="var(--bot-animal-fur)"/><path d="M16 56q-7 23 14 30l-2-21m56-9q7 23-14 30l2-21" fill="var(--bot-animal-shade)"/><ellipse cx="35" cy="49" rx="20" ry="23" fill="var(--bot-animal-face)"/><ellipse cx="65" cy="49" rx="20" ry="23" fill="var(--bot-animal-face)"/><g fill="var(--bot-animal-ink)"><circle cx="36" cy="49" r="7"/><circle cx="64" cy="49" r="7"/></g><g fill="var(--bot-animal-face)"><circle cx="38" cy="47" r="2"/><circle cx="66" cy="47" r="2"/></g><path d="m44 61 6 10 6-10Z" fill="var(--bot-animal-detail)"/><path d="m38 77 4 4 4-4m8 0 4 4 4-4" fill="none" stroke="var(--bot-animal-shade)" stroke-width="3" stroke-linecap="round"/>',
  rabbit:
    '<g fill="var(--bot-animal-face)" stroke="var(--bot-animal-shade)" stroke-width="1.5"><ellipse cx="34" cy="27" rx="11" ry="24" transform="rotate(-10 34 27)"/><ellipse cx="66" cy="27" rx="11" ry="24" transform="rotate(10 66 27)"/></g><g fill="var(--bot-animal-blush)"><ellipse cx="34" cy="25" rx="5" ry="16" transform="rotate(-10 34 25)"/><ellipse cx="66" cy="25" rx="5" ry="16" transform="rotate(10 66 25)"/></g><ellipse cx="50" cy="61" rx="32" ry="29" fill="var(--bot-animal-face)" stroke="var(--bot-animal-shade)" stroke-width="1.5"/>' +
    eyes +
    cheeks +
    '<path d="m46 63 4 4 4-4" fill="var(--bot-animal-blush)"/>' +
    smile,
  bear:
    '<g fill="var(--bot-animal-fur)"><circle cx="24" cy="27" r="15"/><circle cx="76" cy="27" r="15"/></g><g fill="var(--bot-animal-blush)"><circle cx="24" cy="27" r="8"/><circle cx="76" cy="27" r="8"/></g><ellipse cx="50" cy="55" rx="36" ry="35" fill="var(--bot-animal-fur)"/>' +
    eyes +
    '<ellipse cx="50" cy="68" rx="19" ry="15" fill="var(--bot-animal-face)"/><path d="M43 61q7-5 14 0l-7 8Z" fill="var(--bot-animal-ink)"/>' +
    smile +
    cheeks,
  tiger:
    '<g fill="var(--bot-animal-fur)" stroke="var(--bot-animal-ink)" stroke-width="1.5"><circle cx="24" cy="27" r="13"/><circle cx="76" cy="27" r="13"/></g><g fill="var(--bot-animal-face)"><circle cx="24" cy="27" r="7"/><circle cx="76" cy="27" r="7"/></g><ellipse cx="50" cy="55" rx="36" ry="35" fill="var(--bot-animal-fur)"/><g stroke="var(--bot-animal-ink)" stroke-width="4" stroke-linecap="round"><path d="M50 23v15m-9-10h18M18 45l9 5m-11 7 9 3m57-15-9 5m11 7-9 3"/></g>' +
    eyes +
    '<ellipse cx="50" cy="70" rx="19" ry="14" fill="var(--bot-animal-face)"/><path d="m44 62 6-2 6 2-6 7Z" fill="var(--bot-animal-ink)"/>' +
    smile,
  penguin:
    '<path d="M18 67q-12 10-6 14l16-6m54-8q12 10 6 14l-16-6" fill="var(--bot-animal-shade)"/><ellipse cx="50" cy="53" rx="34" ry="40" fill="var(--bot-animal-shade)"/><path d="M24 53q0-26 14-26 8 0 12 10 4-10 12-10 14 0 14 26v13q0 22-26 22T24 66Z" fill="var(--bot-animal-face)"/>' +
    eyes +
    '<path d="m42 62 8-4 8 4-8 9Z" fill="var(--bot-animal-detail)"/>' +
    cheeks +
    '<path d="m32 88-8 5h18m26-5 8 5H58" fill="var(--bot-animal-detail)"/>',
};

export function animalAvatarHtml(name: string): string | null {
  const shape = Object.hasOwn(faces, name) ? faces[name] : undefined;
  return shape
    ? `<span class="icon-slot"><svg viewBox="0 0 100 100" class="bot-animal-symbol" aria-hidden="true">${shape}</svg></span>`
    : null;
}
