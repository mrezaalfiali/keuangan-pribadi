import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocationError } from "@/src/lib/allocation";

/**
 * Penjaga untuk kelas bug "MISSING_MESSAGE" di next-intl, yang muncul sebagai
 * console error di browser dan lolos dari `tsc` karena pesan tidak bertipe.
 *
 * Semua pemeriksaan di sini Berbasis TEKS, bukan hasil `JSON.parse`: parser
 * membuang key duplikat secara diam-diam dan hanya menyisakan yang terakhir, jadi
 * duplikat — penyebab utama bug ini — tidak akan pernah terlihat kalau
 * pemeriksaan dilakukan setelah parse.
 */

const MESSAGES_DIR = join(process.cwd(), "src", "messages");
const LOCALES = ["id", "en"] as const;

type Locale = (typeof LOCALES)[number];

function readMessages(locale: Locale): string {
  return readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8");
}

/**
 * Namespace tingkat atas beserta key langsung di dalamnya.
 *
 * Cukup satu level: namespace yang bertingkat lebih dalam (seperti
 * `calculator.loan.*`) tidak pernah punya key yang sama nama dengan namespace
 * lain pada level yang sama, sehingga duplikat yang berbahaya hanya mungkin
 * terjadi di level ini.
 */
function topLevelKeys(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let namespace = "(root)";
  result.set(namespace, []);

  for (const line of source.split(/\r?\n/)) {
    const namespaceMatch = line.match(/^ {2}"([^"]+)":\s*\{/);
    if (namespaceMatch) {
      namespace = namespaceMatch[1];
      result.set(namespace, []);
      continue;
    }
    const keyMatch = line.match(/^ {4}"([^"]+)"\s*:/);
    if (keyMatch) {
      result.get(namespace)!.push(keyMatch[1]);
    }
  }

  return result;
}

/** Seluruh key di semua kedalaman, ditulis sebagai jalur titik penuh. */
function allKeyPaths(source: string): Set<string> {
  const paths = new Set<string>();
  const walk = (node: unknown, prefix: string) => {
    if (Array.isArray(node)) return;
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") walk(value, path);
      else paths.add(path);
    }
  };
  walk(JSON.parse(source), "");
  return paths;
}

const ALLOCATION_ERRORS: AllocationError[] = [
  "noSlots",
  "needRemainder",
  "tooMuchPercent",
  "badPercent",
  "badAmount",
  "slotVaultRequired",
  "duplicateVault",
];

describe.each(LOCALES)("messages %s", (locale) => {
  it("tidak punya key duplikat di dalam satu namespace", () => {
    const result: string[] = [];
    for (const [namespace, keys] of topLevelKeys(readMessages(locale))) {
      const seen = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) result.push(`${namespace}.${key}`);
        seen.add(key);
      }
    }
    // Key duplikat membuat nilai pertama hilang tanpa warning, dan next-intl
    // tidak pernah memberi tahu soal ini.
    expect(result).toEqual([]);
  });

  it("lolos parse sebagai JSON valid", () => {
    expect(() => JSON.parse(readMessages(locale))).not.toThrow();
  });
});

describe("paritas antar locale", () => {
  it("id dan en punya key yang persis sama", () => {
    const id = allKeyPaths(readMessages("id"));
    const en = allKeyPaths(readMessages("en"));

    const onlyId = [...id].filter((key) => !en.has(key)).sort();
    const onlyEn = [...en].filter((key) => !id.has(key)).sort();

    // Key yang ada di satu locale saja berarti pengguna locale lain melihat
    // key mentah atau MISSING_MESSAGE.
    expect({ onlyId, onlyEn }).toEqual({ onlyId: [], onlyEn: [] });
  });
});

describe("kunci AllocationError terikat ke pesan yang ada", () => {
  it.each(ALLOCATION_ERRORS)("allocation.%s ada di kedua locale", (key) => {
    for (const locale of LOCALES) {
      const paths = allKeyPaths(readMessages(locale));
      expect(paths.has(`allocation.${key}`)).toBe(true);
    }
  });
});

/**
 * Menangkap `t("kunci")` yang dipanggil dengan nama yang salah.
 *
 * next-intl tidak melempar error untuk kunci yang hilang -- ia mengembalikan
 * jalur titik apa adanya, jadi `t("title")` di namespace `auth` tampil
* sebagai literal "auth.title" tanpa gagal build. `register/page.tsx` pernah
   * melakukan persis itu, dan test lain tidak menangkapnya karena yang diuji
* hanya duplikasi dan paritas, bukan key yang benar-benar dipakai.
   *
   * Pencocokan dilakukan lewat teks karena namespace diikat saat translator
   * dibuat (`useTranslations("auth")` lalu `t("title")`), jadi nama key-nya
   * tidak pernah muncul sebagai string utuh di sumber.
   */
describe("kunci yang dipanggil di kode benar-benar ada", () => {
  const SRC_DIR = join(process.cwd(), "src");

  /**
   * Pasangan `namaVariabel -> namespace` dari deklarasi di file ini.
   *
   * `const auth = useTranslations("auth")` memberi `auth("kunci")` yang berarti
   * `auth.kunci`. Mencocokkan setiap variabel hanya dengan namespace-nya
   * sendiri itu penting: `useTranslations` ada belasan kali per halaman, jadi
   * pencocokan silang akan menuduh ratusan key yang tidak pernah dipanggil.
   */
  function translatorBindings(source: string): Array<[string, string]> {
    const bindings: Array<[string, string]> = [];
    const pattern =
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:use|get)Translations\(\s*"([^"]+)"\s*\)/g;
    for (const match of source.matchAll(pattern)) {
      bindings.push([match[1], match[2]]);
    }
    return bindings;
  }

  /**
   * Key yang dipanggil pada file ini,lavery `variabel("kunci")`.
   *
   * Pola `\bt\(` sengaja tidak dipakai di sini: hanya nama variabel yang
   * terikat namespace yang aman dicek, dan ikatan itu sudah diketahui.
   */
  function callsFor(source: string, variable: string): string[] {
    const escaped = variable.replace(/\$/g, "\\$");
    const pattern = new RegExp(`\\b${escaped}\\(\\s*"([\\w.]+)"`, "g");
    return [...source.matchAll(pattern)].map((match) => match[1]);
  }

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("tidak ada kunci yang hilang dari messages/*.json", () => {
    const pathsByLocale = LOCALES.map((locale) => allKeyPaths(readMessages(locale)));

    const missing: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      const where = relative(SRC_DIR, file).replace(/\\/g, "/");

      for (const [variable, namespace] of translatorBindings(source)) {
        // Namespace dinamis (mis. `useTranslations(section)`) tidak punya
        // nama literal, jadi sudah tertangkap regex dan dilewati.
        for (const key of callsFor(source, variable)) {
          const path = `${namespace}.${key}`;
          const exists = pathsByLocale.every((paths) => paths.has(path));
          if (!exists) missing.push(`${where}: ${path}`);
        }
      }
    }

    expect([...new Set(missing)]).toEqual([]);
  });
});
