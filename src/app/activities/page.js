// export default function ActivitiesPage() {
//   return <p><br />Voici les activités</p>;
// }

// /app/activities/page.jsx
"use client";

import { useState, useEffect } from "react";
import { BarChart2 } from "lucide-react";
import { useDefitPrice } from "../components/useDefitPrice"; // adapte le chemin selon ton arborescence
import { activities } from "../activities";

export default function ActivitiesPage() {
  const { price: defitPrice, error } = useDefitPrice();
  const [userFilter, setUserFilter] = useState("Tous");
  const [open, setOpen] = useState(false);

  const uniqueUsers = ["Tous", ...new Set(activities.map((a) => a.utilisateur))];
  const filteredActivities = activities.filter(
    (a) => userFilter === "Tous" || a.utilisateur === userFilter
  );

  useEffect(() => {
    const savedFilter = localStorage.getItem("userFilter");
    if (savedFilter) setUserFilter(savedFilter);
  }, []);

  useEffect(() => {
    localStorage.setItem("userFilter", userFilter);
  }, [userFilter]);

  return (
    <>
      


      
{/* <br/>
<br/> */}
          <h2 className="ombre">
            <BarChart2 size={20} style={{ marginRight: "3px", verticalAlign: "middle", marginBottom: "-1px" }} />
            <span>Liste des activités</span>
          </h2>
          <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "1rem" }}>
            {uniqueUsers.map((user) => (
              <button key={user} onClick={() => setUserFilter(user)} className={`filter-button ${userFilter === user ? "active" : ""}`}>
                {user}
              </button>
            ))}
          </div>

          <section className="activities-section">
            {error ? (
              <p className="price-error">{error}</p>
            ) : defitPrice === null ? (
              <p className="price-loading">Chargement prix DEFIT...</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Utilisateur</th>
                    <th>Activité</th>
                    <th>Gain Brut (Defit)</th>
                    <th>Participation</th>
                    <th>Gain Net (Defit)</th>
                    <th>Gain Net ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActivities.map(({ id, date, utilisateur, activite, defit, participation, defitnet }) => (
                    <tr key={id}>
                      <td>{date}</td>
                      <td>{utilisateur}</td>
                      <td>{activite}</td>
                      <td>{defit}</td>
                      <td>{participation}</td>
                      <td>{defitnet}</td>
                      <td>{(defitnet * defitPrice).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
     

     
     
    </>
  );
}
