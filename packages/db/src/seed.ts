import { insertFind } from "./queries";

const result = insertFind({
  title: "Seeded test find — LocalFinds is wired up",
  url: "https://example.com/localfinds-seed",
  summary:
    "A fake find inserted by `npm run db:seed` to verify the schema and feed render end-to-end. Safe to hide once real finds arrive.",
  agent: "seed",
  tags: ["seed", "smoke-test"],
});

console.log(`seed: ${result.outcome} (find id ${result.id})`);
