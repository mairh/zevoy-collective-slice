import { Node } from "ts-morph";

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "global", "frames", "parent", "top"]);

function literalKey(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  return null;
}

/**
 * Normalises an access chain to dotted text: `window["fetch"]` → `fetch`, `self.fetch` → `fetch`,
 * `process["env"]["KEY"]` → `process.env.KEY`. Returns null when any step is computed at runtime.
 */
export function normalisedAccess(node: Node): string | null {
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) || Node.isAsExpression(node)) {
    return normalisedAccess(node.getExpression());
  }
  if (Node.isIdentifier(node)) {
    return node.getText();
  }
  if (Node.isMetaProperty(node)) {
    return node.getText();
  }
  let owner: string | null = null;
  let name: string | null = null;
  if (Node.isPropertyAccessExpression(node)) {
    owner = normalisedAccess(node.getExpression());
    name = node.getName();
  } else if (Node.isElementAccessExpression(node)) {
    owner = normalisedAccess(node.getExpression());
    const argument = node.getArgumentExpression();
    name = argument ? literalKey(argument) : null;
  }
  if (owner === null || name === null) {
    return null;
  }
  return GLOBAL_OBJECTS.has(owner) ? name : `${owner}.${name}`;
}

/**
 * What a callee or constructor really refers to, resolved through the type checker and through local aliases
 * (`const f = fetch; f(url)`). Returns the global's name when it is declared in a lib or ambient declaration file,
 * otherwise the normalised access text. Detection rules compare against this, never against raw source text, so
 * bracket access, `self.`/`globalThis.` prefixes and renaming do not evade them.
 */
export function resolvedCalleeName(node: Node, depth = 0): string | null {
  if (depth > 8) {
    return null;
  }
  const declaration = node.getSymbol()?.getDeclarations()[0];
  if (declaration && Node.isVariableDeclaration(declaration) && !declaration.getSourceFile().isDeclarationFile()) {
    const initializer = declaration.getInitializer();
    if (
      initializer &&
      (Node.isIdentifier(initializer) ||
        Node.isPropertyAccessExpression(initializer) ||
        Node.isElementAccessExpression(initializer) ||
        Node.isParenthesizedExpression(initializer))
    ) {
      return resolvedCalleeName(initializer, depth + 1);
    }
  }
  const symbol = node.getSymbol();
  if (symbol && declaration?.getSourceFile().isDeclarationFile()) {
    const text = normalisedAccess(node);
    // Prefer the dotted text for members (`axios.get`, `navigator.sendBeacon`) and the symbol name for globals.
    return text?.includes(".") ? text : symbol.getName();
  }
  return normalisedAccess(node);
}
