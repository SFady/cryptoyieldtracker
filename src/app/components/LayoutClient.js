"use client";

import { usePathname } from "next/navigation";
import TopMenu from "./TopMenu";
import BottomMenu from "./BottomMenu";

const validSections = ["home", "activities", "profile"];

export default function LayoutClient({ children }) {
  const pathname = usePathname();
  const currentSection = pathname.split("/")[1] || "home";

  const section = validSections.includes(currentSection)
    ? currentSection
    : "home";

  return (
    <>
        <TopMenu selected={section} />
        {children}
        <BottomMenu selected={section} />
    </>
  );
}
