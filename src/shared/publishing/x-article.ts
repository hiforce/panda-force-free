// The X API uses its own snake_case DraftJS schema, not the browser DraftJS DTO.
export interface XArticleEntity {
  key: string;
  value: {
    type: "link" | "markdown" | "image" | "divider";
    mutability: "mutable" | "immutable";
    data: {
      url?: string;
      markdown?: string;
      media_items?: { media_id: string; media_category: string }[];
      caption?: string;
    };
  };
}
export interface XArticleBlock {
  key: string;
  type:
    | "unstyled"
    | "header-one"
    | "header-two"
    | "header-three"
    | "unordered-list-item"
    | "ordered-list-item"
    | "blockquote"
    | "atomic";
  text: string;
  entity_ranges?: { key: number; offset: number; length: number }[];
  inline_style_ranges?: { style: "bold" | "italic" | "strikethrough"; offset: number; length: number }[];
}
export interface XArticleDraft {
  title: string;
  content_state: { blocks: XArticleBlock[]; entities: XArticleEntity[] };
}
export interface XUploadedImage {
  media_id: string;
  media_category: string;
}
