import ts from "typescript";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const targets = /^server\/(?:knowledge|search|content-sources|creative\/assets|engines\/application-tools)\//;
function branches(body) {
  let total = 1;
  function visit(node) {
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isCaseClause(node)
    )
      total++;
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      total++;
    ts.forEachChild(node, visit);
  }
  if (body) visit(body);
  return total;
}

/** Several concentration signals must agree; file length alone cannot establish a responsibility problem. */
export function inspectBackendStructure(root, files) {
  const classes = [],
    violations = [];
  for (const file of files) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (!targets.test(path) || !/\.tsx?$/.test(path)) continue;
    const source = readFileSync(file, "utf8"),
      ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isClassDeclaration(node)) {
        const methods = node.members.filter(ts.isMethodDeclaration),
          constructor = node.members.find(ts.isConstructorDeclaration),
          dependencies = constructor?.parameters.length ?? 0,
          fields = node.members.filter(ts.isPropertyDeclaration).length,
          start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line,
          lines = ast.getLineAndCharacterOfPosition(node.end).line - start + 1,
          complexity = Math.max(1, ...methods.map((method) => branches(method.body))),
          signals = [
            methods.length > 14 ? "many-methods" : null,
            lines > 260 ? "large-class" : null,
            dependencies > 7 ? "many-collaborators" : null,
            fields > 8 ? "many-state-fields" : null,
            complexity > 24 ? "branch-concentration" : null,
          ].filter(Boolean),
          value = {
            path,
            name: node.name?.text ?? "anonymous",
            lines,
            methods: methods.length,
            dependencies,
            fields,
            complexity,
            signals,
          };
        classes.push(value);
        if (signals.length >= 2)
          violations.push({ ...value, reason: "Review and split responsibilities before adding more behavior" });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { classes, violations };
}
