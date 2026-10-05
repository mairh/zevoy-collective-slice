import { type JsxAttribute, Node, type SourceFile } from "ts-morph";

function isLiteralText(node: Node | undefined): boolean {
  return node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node));
}

function isPresentationalAttribute(attribute: JsxAttribute, presentational: Set<string>): boolean {
  const name = attribute.getNameNode().getText();
  if (!presentational.has(name)) {
    return false;
  }
  if (name === "style" || name === "className") {
    return true;
  }
  const initializer = attribute.getInitializer();
  if (initializer === undefined || isLiteralText(initializer)) {
    return true;
  }
  return Node.isJsxExpression(initializer) && isLiteralText(initializer.getExpression());
}

function isIntrinsic(tagName: string): boolean {
  return /^[a-z]/.test(tagName);
}

function isLayoutOnly(node: Node, presentational: Set<string>): boolean {
  if (Node.isJsxText(node)) {
    return true;
  }
  if (Node.isJsxExpression(node)) {
    return isLiteralText(node.getExpression());
  }
  const opening = Node.isJsxElement(node)
    ? node.getOpeningElement()
    : Node.isJsxSelfClosingElement(node)
      ? node
      : undefined;
  if (!opening || !isIntrinsic(opening.getTagNameNode().getText())) {
    return false;
  }
  const attributesOk = opening
    .getAttributes()
    .every((attribute) => Node.isJsxAttribute(attribute) && isPresentationalAttribute(attribute, presentational));
  if (!attributesOk) {
    return false;
  }
  return Node.isJsxElement(node) ? node.getJsxChildren().every((child) => isLayoutOnly(child, presentational)) : true;
}

/**
 * Prints a file's AST with everything presentational removed: JSX text, string-literal copy attributes, style and
 * className, and intrinsic elements that carry nothing else. Two files with the same fingerprint differ only in
 * copy, styling or layout. That is the deterministic definition of a LOW-risk change.
 */
export function logicFingerprint(sourceFile: SourceFile, presentationalAttributes: string[]): string {
  const presentational = new Set(presentationalAttributes);
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (Node.isJsxAttribute(node) && isPresentationalAttribute(node, presentational)) {
      return;
    }
    const parent = node.getParent();
    const inJsxChildren = parent !== undefined && (Node.isJsxElement(parent) || Node.isJsxFragment(parent));
    if (inJsxChildren && isLayoutOnly(node, presentational)) {
      return;
    }
    parts.push(node.getKindName());
    if (
      Node.isIdentifier(node) ||
      Node.isNumericLiteral(node) ||
      Node.isStringLiteral(node) ||
      Node.isPrivateIdentifier(node)
    ) {
      parts.push(node.getText());
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return parts.join(" ");
}
