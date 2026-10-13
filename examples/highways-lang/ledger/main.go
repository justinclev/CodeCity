package main

import (
	"net"

	"google.golang.org/grpc"
)

func main() {
	lis, _ := net.Listen("tcp", ":50051")
	s := grpc.NewServer()
	pb.RegisterLedgerServer(s, &server{})
	s.Serve(lis)
}
