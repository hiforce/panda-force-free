import { LanguageSupport } from "@codemirror/language";
import { javaLanguage } from "@codemirror/lang-java";
import { styleTags, tags } from "@lezer/highlight";

/** Java's generic definition token needs declaration context to distinguish types from methods and variables. */
export const documentJavaLanguage = javaLanguage.configure({
  props: [
    styleTags({
      Definition: tags.definition(tags.variableName),
      "ClassDeclaration/Definition InterfaceDeclaration/Definition EnumDeclaration/Definition RecordDeclaration/Definition AnnotationTypeDeclaration/Definition TypeParameter/Definition":
        tags.definition(tags.className),
      "MethodDeclaration/Definition ConstructorDeclaration/Definition CompactConstructorDeclaration/Definition":
        tags.function(tags.definition(tags.variableName)),
    }),
  ],
});
export const documentJava = () => new LanguageSupport(documentJavaLanguage);
