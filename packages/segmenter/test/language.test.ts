import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";
import {
  DIACRITIC_LETTER_SHARE,
  EN_FLOOR_SHARE,
  MIN_EVIDENCE_TOKENS,
  NON_EN_STOP_WORD_SHARE,
  NON_LATIN_LETTER_SHARE,
  OTHER_LANGUAGE_DOUBLE_MIN_SHARE,
  OTHER_LANGUAGE_MIN_SHARE,
  decideLanguage,
  languageStats,
} from "../src/language.js";

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

// Telegraphic decision record, about 80 words, few function words.
const DECISION_RECORD =
  "Decision: adopt a token bucket per tenant. Context: the global limit let noisy tenants starve the others, with three incidents in the last quarter. Options: keep the global limit, use a per-tenant bucket, or use a sliding window. Chosen: a per-tenant bucket in Redis, refilled at the plan rate, with a burst of twice the rate. Consequences: one extra Redis round trip, fail open on outage, remaining tokens in a header. Rejected: the sliding window (memory cost) and the global limit (starvation). Owner: platform team. Review: Q3 retro. Follow-ups: load test, alert thresholds, runbook, migration script, rollback plan for the first week.";

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
      "Refactor parseConfig and rename loadProfile to resolveProfile, delete the dead branches, bump deps, regenerate the lockfile, update snapshot tests, tighten types, add a retry wrapper, document the env vars, split the reviewer module, cache compiled packs, drop legacy flags, normalise paths, fix CRLF handling, add fixtures for tables, quotes, fences and lists.";
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
      "polish",
      "Serwer produkcyjny przestał działać wczoraj wieczorem z powodu źle przygotowanej migracji. Przywróciliśmy bazę danych z kopii zapasowej z północy, a następnie ponownie wykonaliśmy brakujące transakcje jedna po drugiej. Żadne dane klientów nie zostały utracone, ale kilka zamówień zostało opóźnionych o kilka godzin.",
    ],
    [
      "swedish",
      "Produktionsservern gick ner igår kväll på grund av en dåligt förberedd migrering. Vi återställde databasen från säkerhetskopian från midnatt och körde sedan om de saknade transaktionerna en efter en. Ingen kunddata gick förlorad, men flera beställningar försenades med några timmar. För att undvika det här lägger vi till ett valideringssteg före varje driftsättning.",
    ],
    [
      "turkish",
      "Üretim sunucusu dün akşam kötü hazırlanmış bir taşıma yüzünden çöktü. Veritabanını gece yarısı yedeğinden geri yükledik ve eksik işlemleri tek tek yeniden çalıştırdık. Hiçbir müşteri verisi kaybolmadı ama birkaç sipariş birkaç saat gecikti. Bunun tekrarlanmaması için her dağıtımdan önce bir doğrulama adımı ekleyeceğiz.",
    ],
    [
      "terse german changelog",
      "## Zusammenfassung\n\n- Retry-Logik mit exponentiellem Backoff im Webhook-Worker hinzugefügt\n- Zähler in Job-Payload verschoben\n- Instabilen Test in der Queue-Suite repariert\n- Ungenutzte Option retryDelayMs entfernt\n- Dokumentation für Migration aktualisiert\n- vitest auf 4.1.12 angehoben\n- Parser-Helfer umbenannt\n- CRLF-Fixtures ergänzt\n- Lint-Regeln für Tests verschärft\n- Veraltetes Konfigurations-Ladeprogramm entfernt\n- Fehlerbehandlung für fehlende Dateien verbessert\n- Protokollierung vereinheitlicht",
    ],
    [
      "terse german without diacritics",
      "- Retry hinzugefügt\n- Zähler verschoben\n- Test repariert und Option entfernt\n- Dokumentation für die Migration aktualisiert\n- Helfer umbenannt und Fixtures ergänzt\n- Regeln verschärft, der Loader ist entfernt\n- Fehlerbehandlung verbessert, die Protokollierung ist vereinheitlicht\n- Konfiguration vereinfacht, Tests ergänzt\n- Abhängigkeiten aktualisiert und Skripte bereinigt\n- Cache beschleunigt und Build repariert",
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
      expect(a.segments.every((s) => s.kind === "prose")).toBe(true);
      expect(a.units.length).toBeGreaterThan(0);
    });
  }

  it("a mixed English paragraph with a few foreign words stays en", () => {
    const t =
      "The team reviewed the plan on Monday and agreed that the first release should ship in March. The French office said bonjour to the new hires and the Spanish office said hola, and everyone liked the idea of a shared welcome email for all of them.";
    expect(lang(t)).toBe("en");
  });
});

describe("language gate: names and places are not evidence", () => {
  const stays: Array<[string, string]> = [
    [
      "a CODEOWNERS-style roster with name particles",
      "Reviewers: Juan de la Cruz, Ana van der Berg, Maria da Silva, Pedro dos Santos, Luca di Marco, Hans von Trapp, Jose del Rio, Sofia de Souza, Anna van Dijk, Carlos de Sousa, Rita da Costa, Marta dos Reis, Tomas del Valle, Ines de Castro, Paulo da Cunha. Owners: Pieter van der Meer, Joao da Rocha, Miguel de Cervantes, Luis dos Anjos.",
    ],
    [
      "reviewers with Spanish names",
      "Please review: Carlos Rodriguez, Maria Gonzalez, Jose Hernandez, Ana Martinez, Luis Garcia, Sofia Lopez, Diego Perez, Lucia Sanchez, Pablo Ramirez, Elena Torres, Javier Flores, Carmen Rivera, Miguel Gomez, Isabel Diaz, Rafael Cruz, Teresa Reyes, Andres Morales, Laura Ortiz, Sergio Castillo, Paula Romero.",
    ],
    [
      "a US and Brazil city list",
      "Offices: Sao Paulo, Rio de Janeiro, Belo Horizonte, Brasilia, Porto Alegre, New York, Los Angeles, San Francisco, San Diego, Las Vegas, El Paso, Santa Fe, Fort Worth, Salt Lake City, Kansas City, Baton Rouge, Santa Barbara, San Antonio, New Orleans, Palo Alto, Mountain View, Buenos Aires, Mexico City, Santiago, Bogota, Lima.",
    ],
    [
      "names with diacritics in a roster",
      "Reviewers: José Álvarez, Zoë Müller, Łukasz Kowalski, Søren Kierkegaard, Åsa Lindqvist, François Hollande, Renée Fleming, Jürgen Klopp, Beyoncé Knowles, Gabriel García Márquez, Björk Guðmundsdóttir, Chloë Sevigny, Joaquín Phoenix, André Previn, Mélanie Laurent, Zoé Saldaña, Penélope Cruz, Gérard Depardieu, Léa Seydoux, Ségolène Royal.",
    ],
  ];
  for (const [name, text] of stays) {
    it(`${name} is en`, () => {
      const a = analyse(text);
      expect(a.prose_words).toBeGreaterThanOrEqual(40);
      expect(a.language).toBe("en");
    });
  }

  it("capitalised runs and particles are left out of the statistics", () => {
    const text = "Juan de la Cruz and Ana van der Berg and Maria da Silva";
    const stats = languageStats(text, [[0, text.length]], []);
    // only the two "and" tokens remain outside runs
    expect(stats.tokens).toBe(2);
    expect(stats.en).toBe(2);
  });

  it("a single capitalised word (a sentence start) is not a run, two in a row are", () => {
    const one = "Added retry logic";
    expect(languageStats(one, [[0, one.length]], []).tokens).toBe(3);
    const two = "Added Retry logic";
    expect(languageStats(two, [[0, two.length]], []).tokens).toBe(1);
  });

  it("a particle between lowercase words is an ordinary word", () => {
    const text = "the de la van";
    expect(languageStats(text, [[0, text.length]], []).tokens).toBe(4);
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

  it("an English share below 0.06 is non_en on its own; at 0.06 it is not", () => {
    expect(EN_FLOOR_SHARE).toBe(0.06);
    const filler = "zzz";
    const s = (en: number): string => [...Array<string>(en).fill("the"), ...Array<string>(50 - en).fill(filler)].join(" ");
    expect(lang(s(2))).toBe("non_en"); // 2/50 = 0.04
    expect(lang(s(3))).toBe("en"); // 3/50 = 0.06 exactly
    expect(lang(Array<string>(40).fill("kubernetes").join(" "))).toBe("non_en"); // zero function words
  });

  it("another language must beat English and reach 0.10", () => {
    expect(OTHER_LANGUAGE_MIN_SHARE).toBe(0.1);
    expect(OTHER_LANGUAGE_DOUBLE_MIN_SHARE).toBe(0.06);
    const s = (en: number, de: number): string =>
      [...Array<string>(en).fill("the"), ...Array<string>(de).fill("und"), ...Array<string>(100 - en - de).fill("zzz")].join(" ");
    expect(lang(s(8, 8))).toBe("en"); // equal shares do not beat English
    expect(lang(s(8, 9))).toBe("en"); // 0.09 beats 0.08 but is below 0.10
    expect(lang(s(8, 10))).toBe("non_en"); // 0.10 beats 0.08 and reaches the floor
    expect(lang(s(12, 14))).toBe("non_en");
    expect(lang(s(15, 40))).toBe("en"); // an English share of 0.15 or more is en whatever else is present
  });

  it("diacritics: more than 3% of letters, with an English share under 0.15, is non_en", () => {
    expect(DIACRITIC_LETTER_SHARE).toBe(0.03);
    // 8 one-letter English tokens ("a") and 60 ten-letter tokens, d of which carry one diacritic: 608 letters
    const withDiacritics = (d: number): string =>
      [...Array<string>(8).fill("a"), ...Array<string>(60 - d).fill("zzzzzzzzzz"), ...Array<string>(d).fill("zzzzzzzzz\u00e9")].join(" ");
    expect(lang(withDiacritics(0))).toBe("en");
    expect(lang(withDiacritics(18))).toBe("en"); // 18/608 = 0.0296
    expect(lang(withDiacritics(19))).toBe("non_en"); // 19/608 = 0.0313
  });

  it("with at least 15% English function words, diacritics do not matter (loanwords, names)", () => {
    const t = Array<string>(8).fill("the").concat(Array<string>(42).fill("café")).join(" ");
    expect(lang(t)).toBe("en");
  });

  it("fewer than the evidence floor of tokens outside capitalised runs is en", () => {
    expect(MIN_EVIDENCE_TOKENS).toBe(25);
    const names = Array.from({ length: 24 }, (_, i) => `x${i}`).join(" ");
    const caps = Array.from({ length: 30 }, () => "Foo Bar").join(" ");
    // 24 lowercase tokens + many capitalised runs: only 24 count
    expect(lang(`${names} ${caps}`)).toBe("en");
    const names25 = Array.from({ length: 25 }, (_, i) => `x${i}`).join(" ");
    expect(lang(`${names25} ${caps}`)).toBe("non_en");
  });

  it("non-Latin letters above 0.3 of all letters are a second signal on their own", () => {
    expect(NON_LATIN_LETTER_SHARE).toBe(0.3);
    const kana = "ああああああああああ"; // 10 letters, no spaces: one token
    // 8 "a" (English) + 62 "z" + K kana tokens: the English share stays between 0.06 and 0.15
    const withKana = (k: number): string => [...Array<string>(8).fill("a"), ...Array<string>(62).fill("z"), ...Array<string>(k).fill(kana)].join(" ");
    expect(lang(withKana(3))).toBe("en"); // 30 / 100 = 0.3 exactly: not above
    expect(lang(withKana(4))).toBe("non_en"); // 40 / 110
  });

  it("all-masked text is en (no tokens, nothing to call foreign)", () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    const a = analyse("`" + words + "`");
    expect(a.prose_words).toBeGreaterThanOrEqual(40);
    expect(a.language).toBe("en");
    expect(decideLanguage({ tokens: 0, en: 0, others: [0, 0, 0, 0, 0, 0], letters: 0, diacritics: 0, nonLatinLetters: 0 })).toBe("en");
  });

  it("tokens inside masks do not count toward either side", () => {
    const foreign = Array<string>(45).fill("und").join(" ");
    const t = `The plan is fine and we ship it in March. \`${foreign}\``;
    expect(lang(t)).toBe("en");
  });
});

describe("language statistics scanner", () => {
  const tokens = (text: string): number => languageStats(text, [[0, text.length]], []).tokens;
  it("agrees with countWords on tokens that are not in capitalised runs, across scripts", () => {
    for (const t of [
      "plain lowercase words here",
      "don't well-known naïve café",
      "привет мир как дела сегодня",
      "καλημέρα κόσμε πώς είσαι",
      "مرحبا بالعالم كيف حالك اليوم",
      "你好 世界 今天 天气",
      "próba dłuższego tekstu",
      "mixed english и русский text",
    ]) {
      expect(tokens(t), t).toBe(analyse(t).units.reduce((n, u) => n + u.words, 0));
    }
  });
  it("counts astral letters as non-Latin letters", () => {
    const text = "𐐨𐐩𐐪 𐐨𐐩𐐪";
    const s = languageStats(text, [[0, text.length]], []);
    expect(s.tokens).toBe(2);
    expect(s.nonLatinLetters).toBeGreaterThan(0);
  });
});
