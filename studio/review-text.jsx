export const reviewTime = (value) => {
  const time = Math.max(0, Number(value) || 0);
  return (
    String(Math.floor(time / 60)).padStart(2, "0") +
    ":" +
    (time % 60).toFixed(2).padStart(5, "0")
  );
};
