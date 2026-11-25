import { describe, expect, it } from "vitest";
import {
  defaultOptions,
  optionLabel,
  optionsProblem,
  optionValueProblem,
  resolveOptions,
  validateOptionsSpec,
  type OptionsSpec,
} from "../src/platform";

const spec: OptionsSpec = {
  stapeln: { label: "7er stapeln", type: "boolean", default: true },
  spielzeit: {
    label: "Spielzeit",
    type: "choice",
    default: 90,
    choices: [
      { value: 60, label: "1 Minute" },
      { value: 90, label: "1,5 Minuten" },
      { value: 120, label: "2 Minuten" },
    ],
  },
  ass: {
    label: "Ass",
    type: "choice",
    default: "nochmal",
    choices: [
      { value: "nochmal", label: "noch mal dran" },
      { value: "aussetzen", label: "Nächster setzt aus" },
    ],
  },
};

describe("validateOptionsSpec", () => {
  it("accepts choice and yes/no with a default", () => {
    expect(validateOptionsSpec(spec)).toEqual([]);
  });

  it("requires a non-empty object", () => {
    expect(validateOptionsSpec([])).toEqual([expect.stringContaining("must be an object")]);
    expect(validateOptionsSpec({})).toEqual([expect.stringContaining("must not be empty")]);
  });

  it("requires names that work as ctx.options.name", () => {
    const problems = validateOptionsSpec({
      "bube-auf-bube": { label: "Bube", type: "boolean", default: false },
      Gross: { label: "Groß", type: "boolean", default: false },
      constructor: { label: "Kaputt", type: "boolean", default: false },
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("ctx.options.bubeaufbube");
    expect(problems[2]).toContain("already taken");
  });

  it("reports wrong types, defaults and unknown fields", () => {
    const problems = validateOptionsSpec({
      a: { label: "A", type: "boolean", default: "ja" },
      b: { label: "B", type: "zahl", default: 1 },
      c: { label: "", type: "boolean", default: true, choices: [] },
      d: { label: "D", type: "choice", default: 4, choices: [{ value: 1, label: "eins" }, { value: 2, label: "zwei" }] },
    });
    expect(problems).toEqual([
      expect.stringContaining("options.a.default"),
      expect.stringContaining("options.b.type"),
      expect.stringContaining("options.c.choices is unknown"),
      expect.stringContaining("options.c.label"),
      expect.stringContaining("options.d.default"),
    ]);
  });

  it("checks the entries of a choice", () => {
    const problems = validateOptionsSpec({
      eins: { label: "Eins", type: "choice", default: 1, choices: [{ value: 1, label: "eins" }] },
      doppelt: { label: "Doppelt", type: "choice", default: 1, choices: [{ value: 1, label: "eins" }, { value: 1, label: "noch eins" }] },
      gemischt: { label: "Gemischt", type: "choice", default: 1, choices: [{ value: 1, label: "eins" }, { value: "zwei", label: "zwei" }] },
      kaputt: {
        label: "Kaputt",
        type: "choice",
        default: 1,
        choices: [{ value: 1, label: "eins", farbe: "rot" }, { value: 1.5, label: "anderthalb" }, { value: "", label: "leer" }, "drei"],
      },
    });
    expect(problems).toEqual([
      expect.stringContaining("options.eins.choices must be a list of 2 to"),
      expect.stringContaining("options.doppelt.choices[1].value 1 appears more than once"),
      expect.stringContaining("options.gemischt.choices mixes numbers and texts"),
      expect.stringContaining("options.kaputt.choices[0].farbe is unknown"),
      expect.stringContaining("options.kaputt.choices[1].value"),
      expect.stringContaining("options.kaputt.choices[2].value"),
      expect.stringContaining("options.kaputt.choices[3] must be an object"),
    ]);
  });

  it("limits the number of options", () => {
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`o${index}`, { label: "O", type: "boolean", default: true }]));
    expect(validateOptionsSpec(many)).toEqual([expect.stringContaining("at most 12")]);
  });
});

describe("resolveOptions", () => {
  it("fills missing options with the default and keeps valid values", () => {
    expect(defaultOptions(spec)).toEqual({ stapeln: true, spielzeit: 90, ass: "nochmal" });
    expect(resolveOptions(spec, { spielzeit: 60, stapeln: false })).toEqual({ stapeln: false, spielzeit: 60, ass: "nochmal" });
  });

  it("sets unknown values to the default and drops unknown options", () => {
    expect(resolveOptions(spec, { spielzeit: 75, stapeln: "ja", ass: 1, alt: true })).toEqual({ stapeln: true, spielzeit: 90, ass: "nochmal" });
    expect(resolveOptions(spec, "kaputt")).toEqual(defaultOptions(spec));
    expect(resolveOptions(undefined, { spielzeit: 60 })).toEqual({});
  });

  it("reads no inherited properties", () => {
    const chosen = Object.create({ stapeln: false }) as Record<string, unknown>;
    expect(resolveOptions(spec, chosen)).toEqual(defaultOptions(spec));
  });
});

describe("optionValueProblem and optionLabel", () => {
  it("explains why a value does not fit", () => {
    expect(optionValueProblem(spec, "spielzeit", 120)).toBeUndefined();
    expect(optionValueProblem(spec, "spielzeit", 75)).toBe("75 is not a value for Spielzeit, possible values are 60, 90, 120");
    expect(optionValueProblem(spec, "stapeln", "ja")).toContain("only true or false");
    expect(optionValueProblem(spec, "toString", true)).toContain("does not exist in this game");
    expect(optionValueProblem(undefined, "stapeln", true)).toContain("does not exist in this game");
  });

  it("names the display name of a value", () => {
    expect(optionLabel(spec["spielzeit"] as OptionsSpec[string], 60)).toBe("1 Minute");
    expect(optionLabel(spec["stapeln"] as OptionsSpec[string], false)).toBe("no");
  });
});

describe("optionsProblem", () => {
  it("lets through only flat objects of short names and simple values", () => {
    expect(optionsProblem({ stapeln: true, spielzeit: 90, ass: "nochmal" })).toBeUndefined();
    expect(optionsProblem([])).toContain("object");
    expect(optionsProblem({ spielzeit: 1.5 })).toContain("options.spielzeit");
    expect(optionsProblem({ spielzeit: { wert: 1 } })).toContain("options.spielzeit");
    expect(optionsProblem({ "kein name": true })).toContain("not an option name");
    expect(optionsProblem({ __proto__x: true })).toContain("not an option name");
  });
});
