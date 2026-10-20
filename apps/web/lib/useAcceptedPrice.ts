'use client';

import { useState } from 'react';

export function useAcceptedPrice(sessionId: string, initialPrice: number) {
  // Initialize to priceAtStart (via initialPrice) on component mount
  const [acceptedPrice, setAcceptedPrice] = useState<number>(initialPrice);

  const acknowledge = (price: number) => {
    setAcceptedPrice(price);
  };

  return { acceptedPrice, acknowledge };
}
