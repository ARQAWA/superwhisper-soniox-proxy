export interface SonioxLanguagePolicy {
  language: string;
  hints: string[];
  identify: boolean;
}

const AUTO_VALUES = new Set(["auto", "multi", "und"]);

/**
 * SuperWhisper's Nova picker has no automatic language option. A selectable
 * sentinel language (Hindi by default) is treated as Soniox auto-detection:
 * no hints, language identification enabled. Every other language keeps the
 * app's selected language as a hint.
 */
export function sonioxLanguagePolicy(
  rawValue: string | null | undefined,
  autoLanguage: string,
): SonioxLanguagePolicy {
  const raw = (rawValue ?? "").trim().toLowerCase();
  const trigger = autoLanguage.trim().toLowerCase().split(/[-_,]/)[0];
  const first = raw.split(/[-_,]/)[0];
  if (trigger && first === trigger) {
    return { language: "auto", hints: [], identify: true };
  }
  if (!first || AUTO_VALUES.has(first)) {
    return { language: "auto", hints: ["ru", "en"], identify: true };
  }
  if (/^[a-z]{2,3}$/.test(first)) {
    return { language: first, hints: [first], identify: first !== "ru" && first !== "en" };
  }
  return { language: "auto", hints: ["ru", "en"], identify: true };
}
