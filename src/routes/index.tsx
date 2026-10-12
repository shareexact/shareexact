import { createFileRoute } from "@tanstack/react-router";
import { DeskApp } from "@/components/desk/DeskApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <DeskApp />;
}
