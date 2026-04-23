import { redirect } from "next/navigation";
import checkAuthent from "../lib/checkAuthent";
import AtrPanel from "./AtrPanel";

export default async function TestPage() {
  const session = await checkAuthent();
  if (session !== "set3") redirect("/home");

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{
        fontFamily: "monospace",
        fontSize: "0.7rem",
        letterSpacing: "2px",
        textTransform: "uppercase",
        color: "#6666aa",
        marginBottom: 20,
      }}>
        ATR Bot — Développement
      </div>
      <AtrPanel />
    </div>
  );
}
