export default function Loading() {
  return (
    <div className="flex flex-col gap-6 pt-2" aria-busy="true" aria-label="Loading">
      <div className="h-14 w-2/3 animate-pulse rounded-2xl bg-sunken" />
      <div className="h-56 animate-pulse rounded-[32px] bg-sunken" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-[28px] bg-sunken" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-[28px] bg-sunken" />
    </div>
  );
}
