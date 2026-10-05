import { useState } from "react";
import { AuthProvider } from "./auth/AuthProvider";
import { CardsPage } from "./ui/cards/CardsPage";
import { Dashboard } from "./ui/dashboard/Dashboard";
import { ExpensesPage } from "./ui/expenses/ExpensesPage";
import { TeamMembers } from "./ui/team/TeamMembers";

type Route = "dashboard" | "cards" | "expenses" | "team";

/** App shell with a minimal tab router. */
export function App() {
  const [route, setRoute] = useState<Route>("dashboard");
  return (
    <AuthProvider>
      <nav>
        {(["dashboard", "cards", "expenses", "team"] as const).map((name) => (
          <button key={name} type="button" onClick={() => setRoute(name)}>
            {name}
          </button>
        ))}
      </nav>
      {route === "dashboard" ? <Dashboard /> : null}
      {route === "cards" ? <CardsPage /> : null}
      {route === "expenses" ? <ExpensesPage /> : null}
      {route === "team" ? <TeamMembers /> : null}
    </AuthProvider>
  );
}
