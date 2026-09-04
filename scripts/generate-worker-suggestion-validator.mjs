import { mkdir, readFile, writeFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const projectRootUrl = new URL("../", import.meta.url);
const schemaUrl = new URL(
  "prototype/suggest-edit/content-suggestion.schema.json",
  projectRootUrl,
);
const generatedDirectoryUrl = new URL(
  "worker/src/generated/",
  projectRootUrl,
);
const generatedValidatorUrl = new URL(
  "worker/src/generated/validate-suggestion.mjs",
  projectRootUrl,
);

const schemaText = await readFile(schemaUrl, "utf8");
const schema = JSON.parse(schemaText);

const ajv = new Ajv2020({
  allErrors: true,
  code: {
    source: true,
    esm: true,
  },
});

const validateSuggestion = ajv.compile(schema);
const generatedCode = standaloneCode(ajv, validateSuggestion);

await mkdir(generatedDirectoryUrl, {
  recursive: true,
});

await writeFile(
  generatedValidatorUrl,
  `${generatedCode}\n`,
  "utf8",
);

console.log(
  "Worker suggestion validator generated: worker/src/generated/validate-suggestion.mjs",
);