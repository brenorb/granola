// Local Nostr relay for Granola QA. One process per relay hostname.
//
//	-addr 127.0.0.1:7001 -url wss://nos.lol -db /path/db [-auth]
//
// With -auth it behaves like an inbox relay (auth.nostr1.com style): every
// REQ and EVENT needs NIP-42 AUTH, and kind 1059 reads are limited to the
// authenticated recipient's own "#p" tag.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"slices"

	"github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip11"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7001", "listen address")
	url := flag.String("url", "", "public wss:// URL this relay answers as")
	dbPath := flag.String("db", "", "badger database directory")
	auth := flag.Bool("auth", false, "require NIP-42 authentication")
	deny := flag.String("deny", "filter", "unauthorized gift-wrap reads: filter (empty result) or closed (CLOSED restricted:)")
	flag.Parse()
	if *url == "" || *dbPath == "" {
		log.Fatal("-url and -db are required")
	}

	db := &badger.BadgerBackend{Path: *dbPath}
	if err := db.Init(); err != nil {
		log.Fatal(err)
	}

	relay := khatru.NewRelay()
	relay.ServiceURL = *url
	relay.Log = log.New(os.Stderr, fmt.Sprintf("[%s] ", *url), log.LstdFlags)
	relay.Info.Name = "granola-qa " + *url
	relay.Info.Description = "Local QA relay"
	relay.Info.SupportedNIPs = []any{1, 9, 11, 17, 40, 42, 59, 70}
	if *auth {
		relay.Info.Limitation = &nip11.RelayLimitationDocument{AuthRequired: true}
	}

	relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
	relay.QueryEvents = append(relay.QueryEvents, db.QueryEvents)
	relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)
	relay.ReplaceEvent = append(relay.ReplaceEvent, db.ReplaceEvent)
	relay.CountEvents = append(relay.CountEvents, db.CountEvents)

	relay.RejectEvent = append(relay.RejectEvent,
		policies.PreventLargeTags(120),
		policies.PreventTimestampsInTheFuture(600),
	)

	if *auth {
		relay.OnConnect = append(relay.OnConnect, func(ctx context.Context) {
			khatru.RequestAuth(ctx)
		})
		relay.RejectFilter = append(relay.RejectFilter, func(ctx context.Context, f nostr.Filter) (bool, string) {
			who := khatru.GetAuthed(ctx)
			if who == "" {
				relay.Log.Printf("reject unauthed filter conn=%p kinds=%v", khatru.GetConnection(ctx), f.Kinds)
				return true, "auth-required: this relay requires authentication"
			}
			if *deny == "closed" && slices.Contains(f.Kinds, 1059) {
				ps := f.Tags["p"]
				if len(ps) != 1 || ps[0] != who {
					relay.Log.Printf("reject 1059 read: conn=%p authed=%s p=%v", khatru.GetConnection(ctx), who, ps)
					return true, "restricted: gift wraps can only be read by their recipient"
				}
			}
			return false, ""
		})
		relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, e *nostr.Event) (bool, string) {
			if khatru.GetAuthed(ctx) == "" {
				return true, "auth-required: publishing requires authentication"
			}
			return false, ""
		})
	}

	if *auth && *deny == "filter" {
		inner := relay.QueryEvents
		relay.QueryEvents = []func(ctx context.Context, f nostr.Filter) (chan *nostr.Event, error){
			func(ctx context.Context, f nostr.Filter) (chan *nostr.Event, error) {
				who := khatru.GetAuthed(ctx)
				out := make(chan *nostr.Event)
				go func() {
					defer close(out)
					for _, q := range inner {
						ch, err := q(ctx, f)
						if err != nil {
							continue
						}
						for e := range ch {
							if e.Kind == 1059 && e.Tags.GetFirst([]string{"p", who}) == nil {
								continue
							}
							out <- e
						}
					}
				}()
				return out, nil
			},
		}
	}

	mux := relay.Router()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	log.Printf("relay %s listening on %s auth=%v", *url, *addr, *auth)
	log.Fatal(http.ListenAndServe(*addr, relay))
}
