'use client';

import { useState } from 'react';

export function useAcceptedPrice(initialPrice: number) {
  const [acceptedPrice, setAcceptedPrice] = useState<number>(initialPrice);

  const acknowledge = (price: number) => {
    setAcceptedPrice(price);
  };

  return { acceptedPrice, acknowledge };
}
