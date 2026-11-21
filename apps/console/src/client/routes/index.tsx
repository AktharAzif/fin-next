// Home (`/`; the Home board's `default` and `noName` states; spec 06 §7.1): the page AppFrame opens
// on. Its lane (L-SAT-06) adds the rest of the board; the frame's states are AppFrame's.
import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "./-home/HomePage.tsx";

export const Route = createFileRoute("/")({
  staticData: { frame: "app", navId: "home", pageName: "Home" },
  component: HomePage,
});
