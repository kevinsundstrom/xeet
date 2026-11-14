import PlaygroundBoot from "./_components/playground-boot.jsx";
import { MAIN_HTML } from "./_lib/main-markup.js";

export default function HomePage() {
  return (
    <>
      <main dangerouslySetInnerHTML={{ __html: MAIN_HTML }} suppressHydrationWarning />
      <PlaygroundBoot />
    </>
  );
}
