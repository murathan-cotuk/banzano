"use client";

import React, { createContext, useContext, useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "@/i18n/navigation";

const UnsavedChangesContext = createContext(null);

export function UnsavedChangesProvider({ children }) {
  const router = useRouter();
  const [isDirty, setDirty] = useState(false);
  const [showNavigateConfirm, setShowNavigateConfirm] = useState(false);
  const [pendingNav, setPendingNav] = useState(null);
  const saveHandlerRef = useRef(null);
  const discardHandlerRef = useRef(null);

  const setHandlers = useCallback(({ onSave, onDiscard } = {}) => {
    saveHandlerRef.current = onSave || null;
    discardHandlerRef.current = onDiscard || null;
  }, []);

  const clearHandlers = useCallback(() => {
    saveHandlerRef.current = null;
    discardHandlerRef.current = null;
  }, []);

  const runSave = useCallback(async () => {
    const fn = saveHandlerRef.current;
    if (typeof fn !== "function") return;
    try {
      const result = await Promise.resolve(fn());
      if (result === false) return;
      setDirty(false);
      setShowNavigateConfirm(false);
      if (pendingNav) {
        const to = pendingNav;
        setPendingNav(null);
        // next-intl router already prefixes locale — do not double-prefix.
        router.push(to);
      }
    } catch {
      // Keep dirty state when save fails
    }
  }, [pendingNav, router]);

  const runDiscard = useCallback(() => {
    const fn = discardHandlerRef.current;
    if (typeof fn === "function") fn();
    setDirty(false);
    setShowNavigateConfirm(false);
    if (pendingNav) {
      const to = pendingNav;
      setPendingNav(null);
      router.push(to);
    }
  }, [pendingNav, router]);

  const startNavigate = useCallback((url) => {
    setPendingNav(url);
    setShowNavigateConfirm(true);
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const value = useMemo(
    () => ({
      isDirty,
      setDirty,
      setHandlers,
      clearHandlers,
      showNavigateConfirm,
      setShowNavigateConfirm,
      pendingNav,
      startNavigate,
      runSave,
      runDiscard,
    }),
    [
      isDirty,
      setDirty,
      setHandlers,
      clearHandlers,
      showNavigateConfirm,
      pendingNav,
      startNavigate,
      runSave,
      runDiscard,
    ],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges() {
  const ctx = useContext(UnsavedChangesContext);
  if (!ctx) return null;
  return ctx;
}
