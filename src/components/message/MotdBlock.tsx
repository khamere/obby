import { mircToHtml } from "../../lib/ircUtils";

// MOTDs are laid out for a fixed-width terminal (ASCII art, aligned
// columns), so they keep their spacing and scroll sideways rather than wrap.
export function MotdBlock({
  lines,
  keyPrefix,
}: {
  lines: string[];
  keyPrefix: string;
}) {
  return (
    <div className="font-mono text-xs leading-snug whitespace-pre overflow-x-auto">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a MOTD's lines never reorder
        <div key={`${keyPrefix}-${i}`}>
          {line ? mircToHtml(line, `${keyPrefix}-${i}-`) : " "}
        </div>
      ))}
    </div>
  );
}
