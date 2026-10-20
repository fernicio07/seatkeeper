'use client';

import { useState, useEffect } from 'react';

export function useAcceptedPrice(sessionId: string, initialPrice: number) {
  // Initialize to session.priceAtStart via initialPrice prop
  const [acceptedPrice, setAcceptedPrice] = useState<number>(initialPrice);

  // If session changes (e.g. fresh ID or reset), synchronize state
  useEffect(() => {
    setAcceptedPrice(initialPrice);
  }, [initialPrice, sessionId]);

  const acknowledge = (price: number) => {
    setAcceptedPrice(price);
  };

  return { acceptedPrice, acknowledge };
}
