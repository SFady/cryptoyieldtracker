export async function POST(req) {
  const { amountUSDC, minPrice, maxPrice, currentPrice } = await req.json();

  // TODO: intégration on-chain (approve + mint Slipstream)
  return Response.json({
    message: `[DRY RUN] Position ${amountUSDC} USDC — range $${minPrice} → $${maxPrice} (spot $${currentPrice})`,
  });
}
