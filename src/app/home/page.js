// export default function ActivitiesPage() {
//   return <p><br />Voici la home</p>;
// }


"use client";

import { useState, useEffect } from "react";
import { BarChart2, User } from "lucide-react";
import { useDefitPrice } from "../components/useDefitPrice";
import { activities } from '../activities';

export default function Home() {
  const buildDate = process.env.BUILD_DATE;
  const [open, setOpen] = useState(false);
  const { price: defitPrice, error } = useDefitPrice();

  const users = [
    { id: 1, name: "Usopp", defit: 0 },
    { id: 2, name: "Nico_Robin", defit: 0 },
    { id: 3, name: "DTeach", defit: 0 }
  ];

  function sommeDefiNetParUtilisateur(defis) {
    return defis.reduce((acc, { utilisateur, defitnet }) => {
      acc[utilisateur] = (acc[utilisateur] || 0) + defitnet;
      return acc;
    }, {});
  }

  const defitSums = sommeDefiNetParUtilisateur(activities);

  const uniqueUsers = ["Tous", ...new Set(activities.map(a => a.utilisateur))];


  const [userFilter, setUserFilter] = useState("Tous");
  const filteredActivities = activities.filter(a => userFilter === "Tous" || a.utilisateur === userFilter);

  // Lire la dernière sélection depuis localStorage au montage
	useEffect(() => {
	  const savedFilter = localStorage.getItem("userFilter");
	  if (savedFilter) setUserFilter(savedFilter);
	}, []);

  // Sauvegarder dans localStorage dès que userFilter change
	useEffect(() => {
	  localStorage.setItem("userFilter", userFilter);
	}, [userFilter]);  
	
  const [periode, setPeriode] = useState("annee");
  
  // 🔁 Lire le filtre depuis localStorage au montage
  useEffect(() => {
    const savedPeriode = localStorage.getItem("periodFilter");
    if (savedPeriode) setPeriode(savedPeriode);
  }, []);

  // 💾 Enregistrer dans localStorage dès que ça change
  useEffect(() => {
    localStorage.setItem("periodFilter", periode);
  }, [periode]);

  function parseDateFR(str) {
    const [jour, mois, annee] = str.split("/").map(Number);
    return new Date(annee, mois - 1, jour);
  }

  function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  function sommeKmParUtilisateur(activities, periodeType) {
    const maintenant = new Date();
    return activities.reduce((acc, { utilisateur, date, km = 0 }) => {
      const d = parseDateFR(date);
      const match =
        (periodeType === "annee" && d.getFullYear() === maintenant.getFullYear()) ||
        (periodeType === "mois" && d.getFullYear() === maintenant.getFullYear() && d.getMonth() === maintenant.getMonth()) ||
        (periodeType === "semaine" && d.getFullYear() === maintenant.getFullYear() && getWeekNumber(d) === getWeekNumber(maintenant));
      if (!match) return acc;
      acc[utilisateur] = (acc[utilisateur] || 0) + km;
      return acc;
    }, {});
  }

  const kmParUtilisateur = sommeKmParUtilisateur(activities, periode);

  return (
    <>
      {/* <div className="container"> */}
        {/* <div className="background-image" />
        <div className="gradient-overlay" /> */}

      

      

          
            {/* <br></br>
            <h2>Bonne nouvelle : Le système de mise à jour du niveau (gold, platinum etc ...) en fonction du cours du Defit a été bloqué par Defit. On garde les mêmes revenus pour le moment.</h2> */}
            
          {/* <br></br> */}
          



          {error ? (
  <p className="price-error" style={{ marginBottom: 0 }}>{error}</p>
) : defitPrice === null ? (
  <p className="price-loading" style={{ marginBottom: 0 }}>Chargement...</p>
) : (
  <p className="defit-price" style={{ marginTop: "20px", marginBottom: 0 }}>
    Prix actuel du <strong>DEFIT</strong> : 
    <span>
      {typeof defitPrice === 'number' ? ` ${defitPrice.toFixed(4)} $` : "?"}
    </span>
  </p>
)}
<p style={{ marginTop: 2 }}>
  Maj : {buildDate ? new Date(buildDate).toLocaleString() : "Date inconnue"}
</p>

          <br />
          <h2 className="ombre"><User size={20} style={{ marginRight: '3px', verticalAlign: 'middle', marginBottom: '3px' }} /><span>Utilisateurs</span></h2>

          <section className="utilisateurs-section">
            <table>
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>Defit</th>
                  <th>Dollars $</th>
                </tr>
              </thead>
              <tbody>
                {users.map(({ id, name }) => {
                  const defit = defitSums[name] || 0;
                  return (
                    <tr key={id}>
                      <td>{name}</td>
                      <td>
                        {typeof defit === "number"
                          ? defit.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }).replace(",", " ")
                          : "?"}
                      </td>
                      <td>
                        {typeof defitPrice === "number" && typeof defit === "number"
                          ? (defit * defitPrice).toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }).replace(",", " ")
                          : "?"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>


	<br /><br />
          <h2 className="ombre"><BarChart2 size={20} style={{ marginRight: '5px', verticalAlign: 'middle' }} />Classement</h2>
	{/* <br/> */}
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            {["annee", "mois", "semaine"].map(p => (
              <button key={p} onClick={() => setPeriode(p)} className={`filter-button ${periode === p ? 'active' : ''}`}>
                {p === 'annee' ? 'Année' : p === 'mois' ? 'Mois' : 'Semaine'}
              </button>
            ))}
          </div>

          <section className="activities-section">
            <table>
              <thead>
                <tr>
                  <th>Place</th>
		  <th>Utilisateur</th>
                  <th>Kilomètres</th>
                </tr>
              </thead>
              <tbody>
{Object.entries(kmParUtilisateur)
  .sort((a, b) => b[1] - a[1])
  .map(([utilisateur, km], index) => (
    <tr key={utilisateur}>
      <td>{index+1}</td>
      <td>{utilisateur}</td>
      <td>{km.toFixed(2)}</td>
    </tr>
))}
              </tbody>
            </table>
          </section>




          
        
  
      {/* </div> */}

    </>
  );
}
