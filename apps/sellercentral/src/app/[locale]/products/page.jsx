"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

export default function ProductsIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/products/inventory");
  }, [router]);
  return null;
}
