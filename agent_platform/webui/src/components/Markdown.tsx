import { renderMarkdown } from "../lib/markdown";
import { cx } from "../lib/ui";

interface MarkdownProps {
  text: string;
  className?: string;
}

/** 统一的 markdown 渲染入口:DOMPurify + hljs + 代码卡片装饰。 */
export function Markdown({ text, className = "" }: MarkdownProps) {
  return (
    <div
      className={cx("md", className)}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
