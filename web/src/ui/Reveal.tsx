import { motion } from "motion/react";
import { easeOut, useMotionOn } from "./motion";

const lines = [
  ["Say", "it", "once."],
  ["The", "AI", "does", "the", "work."],
];

export function RevealHeadline({ className }: { className?: string }) {
  const motionOn = useMotionOn();
  const label = "Say it once. The AI does the work.";

  if (!motionOn) {
    return (
      <h1 className={className}>
        <span className="line">Say it once.</span>
        <span className="line">The AI does the work.</span>
      </h1>
    );
  }

  return (
    <h1 className={className} aria-label={label}>
      {lines.map((words, lineIndex) => (
        <span key={words.join("-")} className="line" aria-hidden="true">
          {words.map((word, wordIndex) => (
            <span key={`${word}-${wordIndex}`} className="word-mask">
              <motion.span
                className="word"
                initial={{ y: "110%", opacity: 0 }}
                animate={{ y: "0%", opacity: 1 }}
                transition={{
                  duration: 0.9,
                  delay: 0.16 + lineIndex * 0.22 + wordIndex * 0.055,
                  ease: easeOut,
                }}
              >
                {word}
                {wordIndex < words.length - 1 ? "\u00A0" : ""}
              </motion.span>
            </span>
          ))}
        </span>
      ))}
    </h1>
  );
}
