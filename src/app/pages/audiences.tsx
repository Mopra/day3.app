import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Audience } from "../lib/types";

export function AudiencesPage() {
  const api = useApi();
  const [audiences, setAudiences] = useState<Audience[] | null>(null);
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<{ name: string }>();

  const load = useCallback(() => {
    api
      .get<{ audiences: Audience[] }>("/api/audiences")
      .then((res) => setAudiences(res.audiences))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post("/api/audiences", values);
      toast.success("Audience created");
      setOpen(false);
      reset();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Audiences</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button>New audience</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create audience</DialogTitle>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="Product updates" {...register("name", { required: true })} />
              </div>
              <Button type="submit" disabled={formState.isSubmitting} className="w-full">
                Create
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent>
          {audiences === null ? (
            <Skeleton className="h-24 w-full" />
          ) : audiences.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Create an audience, then import the users you want to keep updated.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subscribed</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audiences.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link to={`/audiences/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell>{a.subscriberCount ?? 0}</TableCell>
                    <TableCell>{formatDate(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
