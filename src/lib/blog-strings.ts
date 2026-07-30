import type { Lang } from './blog'

/**
 * The blog's own chrome, in both languages.
 *
 * Deliberately not a general i18n framework. Two languages and one section of
 * the site do not justify a runtime, a loader and a key namespace; a typed
 * record fails at compile time if a string is missing from either language,
 * which is the only guarantee a framework would have bought us here.
 */
export const T = {
  en: {
    home: 'Home',
    blog: 'Blog',
    blogTitle: 'Blog',
    blogIntro: 'Notes on agent identity, payments and the trust layer between them.',
    whatYoullLearn: "What you'll learn",
    author: 'Author',
    share: 'Share',
    copyLink: 'Copy link',
    shareOnX: 'Share on X',
    shareOnLinkedIn: 'Share on LinkedIn',
    keepReading: 'Keep reading',
    readInTurkish: 'Türkçe oku',
    readInEnglish: 'Read in English',
    metaSuffix: 'A-Identity',
  },
  tr: {
    home: 'Ana sayfa',
    blog: 'Blog',
    blogTitle: 'Blog',
    blogIntro: 'Ajan kimliği, ödemeler ve ikisinin arasındaki güven katmanı üzerine notlar.',
    whatYoullLearn: 'Bu yazıda ne var',
    author: 'Yazar',
    share: 'Paylaş',
    copyLink: 'Bağlantıyı kopyala',
    shareOnX: "X'te paylaş",
    shareOnLinkedIn: "LinkedIn'de paylaş",
    keepReading: 'Okumaya devam et',
    readInTurkish: 'Türkçe oku',
    readInEnglish: 'Read in English',
    metaSuffix: 'A-Identity',
  },
} satisfies Record<Lang, Record<string, string>>

export const t = (lang: Lang) => T[lang]
