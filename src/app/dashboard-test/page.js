"use client";

import { useState } from "react";
import styles from "./page.module.css";

// Items placés approximativement à leur emplacement sur le corps (top/left en % de la stage)
const ITEMS = [
  { key: "watch",  name: "Watch",   price: 200, top: 18, left: 72 },
  { key: "tshirt", name: "T-Shirt", price: 25,  top: 34, left: 50 },
  { key: "shorts", name: "Shorts",  price: 50,  top: 52, left: 50 },
  { key: "socks",  name: "Socks",   price: 10,  top: 70, left: 50 },
  { key: "shoes",  name: "Shoes",   price: 100, top: 88, left: 50 },
];

export default function DashboardTestPage() {
  const [owned, setOwned] = useState({});

  const buy  = (key) => setOwned((o) => ({ ...o, [key]: true }));
  const sell = (key) => setOwned((o) => ({ ...o, [key]: false }));

  return (
    <div className={styles.wrapper}>
      <div className={styles.stage}>
        <div className={styles.axis} />
        {ITEMS.map((item) => {
          const isOwned = !!owned[item.key];
          return (
            <div
              key={item.key}
              className={`${styles.item} ${isOwned ? styles["item--owned"] : ""}`}
              style={{ top: `${item.top}%`, left: `${item.left}%` }}
            >
              <div className={styles.itemHead}>
                <span className={styles.itemName}>{item.name}</span>
                <span className={styles.itemPrice}>{item.price} $</span>
              </div>
              {isOwned && <span className={styles.ownedTag}>Owned</span>}
              <div className={styles.itemActions}>
                <button
                  className={styles.buyBtn}
                  disabled={isOwned}
                  onClick={() => buy(item.key)}
                >
                  Buy
                </button>
                <button
                  className={styles.sellBtn}
                  disabled={!isOwned}
                  onClick={() => sell(item.key)}
                >
                  Sell
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
