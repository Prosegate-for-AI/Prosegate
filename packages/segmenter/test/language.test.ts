import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";
import { NON_EN_STOP_WORD_SHARE, NON_LATIN_LETTER_SHARE, OTHER_LANGUAGE_MIN_SHARE, decideLanguage } from "../src/language.js";

const lang = (t: string): string => analyse(t).language;

const TERSE_CHANGELOG = [
  "## Summary",
  "",
  "- Added retry logic with exponential backoff to the webhook worker",
  "- Moved attempt counter into job payload",
  "- Fixed flaky test in queue suite",
  "- Removed unused retryDelayMs option",
  "- Updated docs for migration",
  "- Bumped vitest to 4.1.12",
  "- Renamed parse helpers for clarity",
  "- Added CRLF fixtures",
  "- Tightened lint rules for tests",
  "- Dropped legacy config loader",
].join("\n");

// Telegraphic decision record, 79 words, almost no function words.
const DECISION_RECORD =
  "Decision: adopt token bucket per tenant. Context: global limit let noisy tenants starve neighbours; three incidents last quarter. " +
  "Options: global limit (status quo), per-tenant bucket, sliding window. Chosen: per-tenant bucket, Redis storage, refill at plan rate, " +
  "burst double rate. Consequences: extra Redis round trip, fail open on outage, remaining-token header, new dashboards. " +
  "Rejected: sliding window (memory cost, complexity), global limit (starvation). Owner: platform team. Review: Q3 retro. " +
  "Follow-ups: load test, alert thresholds, runbook, customer comms, migration script, rollback plan.";

describe("language gate: terse English is English", () => {
  it("a changelog-style bullet reply is en (it has few function words but no second signal)", () => {
    const a = analyse(TERSE_CHANGELOG);
    expect(a.prose_words).toBeGreaterThanOrEqual(40);
    expect(a.language).toBe("en");
  });

  it("an ~80-word decision record is en", () => {
    const a = analyse(DECISION_RECORD);
    expect(a.prose_words).toBeGreaterThanOrEqual(75);
    expect(a.language).toBe("en");
  });

  it("code-flavoured English with identifiers stays en", () => {
    const t =
      "Refactor parseConfig, rename loadProfile to resolveProfile, delete dead branches, bump deps, regenerate lockfile, " +
      "update snapshot tests, tighten types, add retry wrapper, document env vars, split reviewer module, cache compiled packs, " +
      "drop legacy flags, normalise paths, fix CRLF handling, add fixtures for tables, quotes, fences, lists.";
    expect(analyse(t).language).toBe("en");
  });
});

describe("language gate: other languages are non_en", () => {
  const samples: Array<[string, string]> = [
    [
      "german",
      "Der Server ist gestern Abend ausgefallen, weil die Migration nicht richtig vorbereitet war. Wir haben die Datenbank aus der Sicherung von Mitternacht wiederhergestellt und danach die fehlenden Transaktionen einzeln erneut ausgeführt. Es ist keine Kundendatei verloren gegangen, aber einige Bestellungen wurden um mehrere Stunden verzögert. Um das zu vermeiden, werden wir vor jedem Einsatz einen Prüfschritt einfügen.",
    ],
    [
      "french",
      "Le serveur de production est tombé hier soir à cause d'une migration mal préparée. Nous avons restauré la base de données depuis la sauvegarde de minuit, puis nous avons rejoué les transactions manquantes une par une. Aucune donnée client n'a été perdue, mais plusieurs commandes ont été retardées de quelques heures.",
    ],
    [
      "spanish",
      "El servidor de producción se cayó anoche por una migración mal preparada. Restauramos la base de datos desde la copia de seguridad de medianoche y luego volvimos a ejecutar las transacciones que faltaban una por una. No se perdió ningún dato de clientes, pero varios pedidos se retrasaron durante algunas horas.",
    ],
    [
      "dutch",
      "De server is gisteravond uitgevallen omdat de migratie niet goed was voorbereid. We hebben de database hersteld vanaf de back-up van middernacht en daarna de ontbrekende transacties een voor een opnieuw uitgevoerd. Er is geen klantdata verloren gegaan, maar een aantal bestellingen is met enkele uren vertraagd.",
    ],
    [
      "portuguese",
      "O servidor de produção caiu ontem à noite por causa de uma migração mal preparada. Nós restauramos o banco de dados a partir do backup da meia-noite e depois reexecutamos as transações que faltavam uma por uma. Nenhum dado de cliente foi perdido, mas vários pedidos foram atrasados por algumas horas.",
    ],
    [
      "italian",
      "Il server di produzione è andato in errore ieri sera a causa di una migrazione preparata male. Abbiamo ripristinato il database dal backup di mezzanotte e poi abbiamo rieseguito le transazioni mancanti una per una. Non è stato perso nessun dato dei clienti, ma diversi ordini sono stati ritardati di alcune ore.",
    ],
    [
      "arabic",
      "توقف خادم الإنتاج مساء أمس بسبب ترحيل لم يتم إعداده بشكل جيد. قمنا باستعادة قاعدة البيانات من النسخة الاحتياطية لمنتصف الليل ثم أعدنا تنفيذ المعاملات المفقودة واحدة تلو الأخرى. لم تفقد أي بيانات للعملاء لكن تأخرت عدة طلبات لساعات قليلة. لتجنب تكرار ذلك سنضيف خطوة تحقق قبل كل عملية نشر.",
    ],
    [
      "russian",
      "Рабочий сервер упал вчера вечером из-за плохо подготовленной миграции. Мы восстановили базу данных из резервной копии полуночи, а затем по одной повторно выполнили недостающие транзакции. Данные клиентов не были потеряны, но несколько заказов задержались на несколько часов. Чтобы этого больше не случилось, мы добавим этап проверки перед каждым развёртыванием.",
    ],
    [
      "japanese (words separated by punctuation)",
      Array.from({ length: 6 }, () => "サーバー、昨夜、停止、移行、準備、不足、復旧、取引、再実行、検証").join("、"),
    ],
  ];
  for (const [name, text] of samples) {
    it(`${name} is non_en without dropping its prose`, () => {
      const a = analyse(text);
      expect(a.prose_words, "sample must be long enough for the gate").toBeGreaterThanOrEqual(40);
      expect(a.language).toBe("non_en");
      expect(a.segments.map((s) => s.kind)).toEqual(["prose"]);
      expect(a.units.length).toBeGreaterThan(0);
    });
  }

  it("a mixed English paragraph with a few foreign words stays en", () => {
    const t =
      "The team reviewed the plan on Monday and agreed that the first release should ship in March. The French office said bonjour to the new hires and the Spanish office said hola, and everyone liked the idea of a shared welcome email for all of them.";
    expect(lang(t)).toBe("en");
  });
});

describe("language gate: thresholds", () => {
  // 40 tokens: n x "the" (English stop word) and the rest "und" (German stop word).
  const mix = (en: number): string => [...Array<string>(en).fill("the"), ...Array<string>(40 - en).fill("und")].join(" ");

  it("exactly 0.15 English share is en; just below, with a second signal, is non_en", () => {
    expect(NON_EN_STOP_WORD_SHARE).toBe(0.15);
    expect(analyse(mix(6)).prose_words).toBe(40);
    expect(lang(mix(6))).toBe("en"); // 6/40 = 0.15 exactly: not below the threshold
    expect(lang(mix(5))).toBe("non_en"); // 5/40 = 0.125 and German beats English
  });

  it("39 words is unknown whatever the content; 40 decides", () => {
    expect(lang(Array<string>(39).fill("und").join(" "))).toBe("unknown");
    expect(lang(Array<string>(40).fill("und").join(" "))).toBe("non_en");
  });

  it("a low English share alone is not enough: no other language, no non-Latin script", () => {
    expect(lang(Array<string>(40).fill("kubernetes").join(" "))).toBe("en");
  });

  it("another language must beat English and reach the minimum share", () => {
    const s = (en: number, de: number): string =>
      [...Array<string>(en).fill("the"), ...Array<string>(de).fill("und"), ...Array<string>(40 - en - de).fill("zzz")].join(" ");
    expect(OTHER_LANGUAGE_MIN_SHARE).toBe(0.1);
    expect(lang(s(0, 3))).toBe("en"); // 3/40 = 0.075 German is below the floor
    expect(lang(s(0, 4))).toBe("non_en"); // 4/40 = 0.10 is at the floor
    expect(lang(s(4, 4))).toBe("en"); // equal shares do not beat English
    expect(lang(s(4, 5))).toBe("non_en");
  });

  it("non-Latin letters above 0.3 of all letters are a second signal on their own", () => {
    expect(NON_LATIN_LETTER_SHARE).toBe(0.3);
    const latin = "zzzzzzzzzz"; // 10 letters
    const kana = "ああああああああああ"; // 10 letters, no spaces: one token
    const mixed = (nLatin: number, nKana: number): string => [...Array<string>(nLatin).fill(latin), ...Array<string>(nKana).fill(kana)].join(" ");
    // 40 tokens; nonLatin share = kana/(latin+kana) of letters
    expect(lang(mixed(28, 12))).toBe("en"); // 12/40 = 0.3 exactly: not above
    expect(lang(mixed(27, 13))).toBe("non_en");
  });

  it("all-masked text is en (no tokens, nothing to call foreign)", () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    const a = analyse("`" + words + "`");
    expect(a.prose_words).toBeGreaterThanOrEqual(40);
    expect(a.language).toBe("en");
    expect(decideLanguage({ tokens: 0, en: 0, others: [0, 0, 0, 0, 0, 0], letters: 0, nonLatinLetters: 0 })).toBe("en");
  });

  it("tokens inside masks do not count toward either side", () => {
    const foreign = Array<string>(45).fill("und").join(" ");
    const t = `The plan is fine and we ship it in March. \`${foreign}\``;
    expect(lang(t)).toBe("en");
  });
});
